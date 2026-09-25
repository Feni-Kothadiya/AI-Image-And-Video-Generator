import Fastify from "fastify";
import { createStorage } from "./storage.mjs";
import { bundledNames, bundledPath } from "./bundled-media.mjs";
import { detectMedia } from "./media-download.mjs";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync, createReadStream, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectDatabase,
  getSetting,
  setSetting,
  transaction,
  credit,
  audit,
  now,
  publicUser,
} from "./db.mjs";
import {
  configSchema,
  credentialsSchema,
  adminCredentialsSchema,
  integrationSchema,
  parse,
  fail,
} from "./schema.mjs";
import {
  authenticate,
  hashPassword,
  verifyPassword,
  hash,
  newSession,
  masterKey,
  encrypt,
} from "./security.mjs";
import { createGateway, validateGatewayUrl } from "./gateway.mjs";
import {
  createFalGateway,
  falImageCatalog,
  falImageSizes,
  falModels,
  isFalImageModel,
  normalizeFalSettings,
} from "./fal.mjs";
import { createJob, publicJob, settleJob, createWorker } from "./jobs.mjs";
import { createPlayBilling } from "./play-billing.mjs";
import { createBilling } from "./billing.mjs";
export async function buildApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || "./data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
  const db =
    options.db || (await connectDatabase(join(dataDir, "studio.sqlite")));
  const key = masterKey(dataDir);
  const play = options.playBilling || createPlayBilling();
  const billing = createBilling({ db, play, key });
  const storage = options.storage || createStorage({ dataDir });
  const falKey = options.falKey ?? process.env.FAL_KEY?.trim();
  const verifyRewardedAd = options.verifyRewardedAd;
  const deletingUsers = new Set();
  async function presentJob(job) {
    const result = publicJob(job);
    if (job.result_media && job.status === "succeeded") {
      const media = JSON.parse(job.result_media);
      result.resultUrl = await storage.resultUrl(media);
      result.resultMime = media.mime;
    }
    return result;
  }
  const production = process.env.NODE_ENV === "production";
  const adminOrigin =
    options.adminOrigin || process.env.ADMIN_ORIGIN || "http://localhost:4000";
  const appOrigin = process.env.APP_WEB_ORIGIN || "http://localhost:8081";
  const allowedHosts =
    options.allowedHosts ?? process.env.AI_ALLOWED_HOSTS ?? "";
  const app = Fastify({
    logger: options.logger ?? {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === "1",
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  });
  app.decorate("db", db);
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (production)
      reply.header("Strict-Transport-Security", "max-age=31536000");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (
      req.url.startsWith("/api/admin/") &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== adminOrigin
    )
      fail(403, "Dashboard origin does not match ADMIN_ORIGIN.");
    if (
      req.headers.origin === appOrigin &&
      !req.url.startsWith("/api/admin/")
    ) {
      reply
        .header("Access-Control-Allow-Origin", appOrigin)
        .header("Vary", "Origin");
      if (req.method === "OPTIONS")
        return reply
          .header(
            "Access-Control-Allow-Methods",
            "GET,POST,DELETE,PATCH,OPTIONS",
          )
          .header(
            "Access-Control-Allow-Headers",
            "Content-Type,Authorization,Idempotency-Key",
          )
          .code(204)
          .send();
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const code = error.statusCode || 500;
    if (code >= 500 && code !== 503)
      req.log.error({ type: error.name }, "Request failed.");
    reply.code(code).send({
      error:
        code >= 500 && code !== 503
          ? "An unexpected server error occurred. Please retry."
          : error.message,
    });
  });
  app.get("/api/health", async () => ({
    status: "ok",
    database: !!(await db.prepare("SELECT 1 AS ok").get()).ok,
  }));
  // Lightweight liveness response for an external scheduler; no provider work.
  app.get("/api/cron/ping", async () => ({
    success: true,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
  }));
  const mobile = async (req) => {
    req.user = await authenticate(db, req);
  };
  const admin = async (req) => {
    req.user = await authenticate(db, req, true);
  };
  const limited = { rateLimit: { max: 10, timeWindow: "15 minutes" } };
  const ready = (integration, mode) =>
    options.gateway
      ? true
      : integration.provider === "fal"
        ? !!(
          integration.enabled &&
          falKey &&
          storage.mode === "r2" &&
          ["image", "video", "dance"].includes(mode)
        )
        : !!(
          integration.enabled &&
          integration.secret &&
          integration.gatewayUrl &&
          integration.models[mode] &&
          allowedHosts
            .split(",")
            .map((v) => v.trim())
            .includes(new URL(integration.gatewayUrl).hostname)
        );
  async function configEnvelope() {
    const published = await getSetting(db, "published");
    const integration = await getSetting(db, "integration");
    const content = structuredClone(published.content);
    content.templates = content.templates
      .filter((t) => t.enabled)
      .sort((a, b) => a.order - b.order);
    content.plans = content.plans.filter((t) => t.enabled);
    content.coinPacks = content.coinPacks.filter((t) => t.enabled);
    content.home.featuredIds = content.home.featuredIds.filter((id) =>
      content.templates.some((t) => t.id === id),
    );
    const billingReady = play.enabled;
    const adsReady = content.features.ads && typeof verifyRewardedAd === "function";
    if (!billingReady) {
      content.plans = [];
      content.coinPacks = [];
      content.templates = content.templates.map((template) => ({ ...template, premium: false }));
    }
    if (!adsReady) {
      content.features.ads = false;
      content.features.bannerAds = false;
      content.features.appOpenAds = false;
      content.features.interstitialAds = false;
      content.features.rewardedAds = false;
    }
    return {
      ...published,
      content,
      services: {
        image: ready(integration, "image"),
        video: ready(integration, "video"),
        dance: ready(integration, "dance"),
        slideshow: ready(integration, "slideshow"),
        billing: billingReady,
        ads: adsReady,
      },
      serverDate: new Date().toISOString().slice(0, 10),
    };
  }
  app.get("/api/config", async () => await configEnvelope());
  const escapeHtml = (value = "") =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  const legalDocument = ({ title, text, content = "" }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Genora</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#05091a;color:#eef3ff;font:16px/1.7 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(760px,calc(100% - 32px));margin:48px auto;padding:clamp(24px,5vw,52px);background:linear-gradient(145deg,#111a38,#080d20);border:1px solid #26335f;border-radius:28px;box-shadow:0 24px 80px #0008}a{color:#5fd7ff}h1{font-size:clamp(30px,7vw,48px);line-height:1.1;margin:0 0 12px}p.policy{white-space:pre-wrap;color:#cbd5ef}.eyebrow{color:#66dcff;font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}label{display:block;font-weight:700;margin:18px 0 7px}input{width:100%;padding:14px 16px;color:#fff;background:#080d20;border:1px solid #34446f;border-radius:12px;font:inherit}button{width:100%;margin-top:22px;padding:15px;border:0;border-radius:14px;background:linear-gradient(90deg,#13c6f3,#6755ff,#ff3caf);color:#fff;font:inherit;font-weight:800;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.note,#result{color:#aebbdc;font-size:14px}#result{min-height:24px;margin-top:14px}.links{display:flex;gap:18px;flex-wrap:wrap;margin-top:28px}
</style></head><body><main><div class="eyebrow">Genora AI Image &amp; Video Editor</div><h1>${escapeHtml(title)}</h1>${text ? `<p class="policy">${escapeHtml(text)}</p>` : content}<div class="links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/account-deletion">Delete account</a></div></main></body></html>`;
  const appProfileDocument = ({ playStoreUrl }) => {
    const storeLink = playStoreUrl
      ? `<a class="button primary" href="${escapeHtml(playStoreUrl)}" rel="noopener">View on Google Play <span aria-hidden="true">&#8599;</span></a>`
      : "";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Official product and payment information for Genora AI Image Video Editor, an Android app for AI image and video creation.">
<meta name="theme-color" content="#070a18"><meta property="og:type" content="website"><meta property="og:title" content="Genora AI Image Video Editor"><meta property="og:description" content="Create original AI images and videos from prompts and photos.">
<title>Genora AI Image Video Editor · Official App Information</title><style>
:root{color-scheme:dark;--ink:#f5f7ff;--muted:#aeb7d4;--line:#293252;--cyan:#59e7ff;--violet:#8f74ff;--pink:#ff5ecb}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#070a18;color:var(--ink);font:16px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-x:hidden}body:before{content:"";position:fixed;inset:-30vh -20vw auto;height:75vh;background:radial-gradient(circle at 22% 45%,#127aff44,transparent 38%),radial-gradient(circle at 66% 10%,#c14fff33,transparent 32%),radial-gradient(circle at 88% 70%,#00d9ff22,transparent 34%);filter:blur(18px);pointer-events:none;z-index:-1}a{color:inherit}header,main,footer{width:min(1160px,calc(100% - 40px));margin-inline:auto}header{height:84px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff12}.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-weight:850;letter-spacing:-.02em}.mini-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#15355d,#6d45db 55%,#ff4ebc);box-shadow:inset 0 1px #ffffff55,0 8px 24px #6a45df44}.mini-mark svg{width:24px;height:24px}nav{display:flex;gap:26px}nav a,.footer-links a{color:var(--muted);text-decoration:none;font-size:14px;font-weight:650}nav a:hover,.footer-links a:hover{color:#fff}.hero{min-height:660px;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(310px,.9fr);gap:60px;align-items:center;padding:74px 0 88px}.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid #5ce3ff55;border-radius:999px;background:#39c5ef11;color:#93efff;text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:850}.eyebrow:before{content:"";width:7px;height:7px;border-radius:50%;background:#64f1d0;box-shadow:0 0 14px #64f1d0}h1{font-size:clamp(46px,7vw,82px);line-height:.98;letter-spacing:-.055em;margin:24px 0 26px;max-width:780px}.gradient{background:linear-gradient(95deg,#fff 15%,#74e7ff 48%,#b88bff 70%,#ff86d7);-webkit-background-clip:text;background-clip:text;color:transparent}.lead{max-width:650px;color:#c0c8de;font-size:clamp(18px,2vw,21px);line-height:1.65}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:34px}.button{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:50px;padding:0 20px;border:1px solid #394462;border-radius:14px;text-decoration:none;font-weight:800;font-size:14px;background:#11162a}.button.primary{border:0;background:linear-gradient(100deg,#159dd1,#7251e9 55%,#e240ae);box-shadow:0 13px 34px #6d45e33d}.visual{position:relative;min-height:470px;display:grid;place-items:center}.visual:before{content:"";position:absolute;width:390px;height:390px;border-radius:50%;background:conic-gradient(from 210deg,#2fe8ff,#7053ff,#f54fbd,#ffbd72,#2fe8ff);filter:blur(1px);opacity:.5}.phone{position:relative;width:min(310px,82vw);aspect-ratio:.56;border:1px solid #ffffff42;border-radius:48px;padding:11px;background:linear-gradient(145deg,#323a5b,#090c19 35%);box-shadow:0 42px 90px #0009,0 0 100px #714dff33;transform:rotate(4deg)}.screen{height:100%;overflow:hidden;border-radius:38px;background:linear-gradient(160deg,#131c40,#080b19 52%,#240f38);padding:30px 20px}.screen-top{display:flex;justify-content:space-between;align-items:center}.screen-mark{width:57px;height:57px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(145deg,#10badc,#744ee9 57%,#f84fbf);font-size:23px;font-weight:900}.coin{padding:7px 10px;border-radius:999px;background:#ffffff12;color:#ffe191;font-size:12px;font-weight:800}.screen-copy{margin-top:36px}.screen-copy b{font-size:26px;line-height:1.15;display:block}.screen-copy span{display:block;color:#9eabcf;font-size:12px;margin-top:8px}.prompt{margin-top:28px;padding:15px;border:1px solid #ffffff1f;border-radius:16px;background:#ffffff0b;color:#aab5d2;font-size:12px}.art-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.art{height:112px;border-radius:16px;background:radial-gradient(circle at 52% 35%,#ffd5b7 0 8%,transparent 9%),linear-gradient(145deg,#375ba8,#8f4ab5 52%,#e8956d);position:relative;overflow:hidden}.art:nth-child(2){background:radial-gradient(circle at 50% 38%,#f4c8a1 0 8%,transparent 9%),linear-gradient(150deg,#133c53,#18a6a5 50%,#f5b34e)}.generate{height:44px;margin-top:18px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(90deg,#21add6,#7652eb,#ef4eb8);font-size:12px;font-weight:850}.section{padding:88px 0;border-top:1px solid #ffffff12}.section-head{display:grid;grid-template-columns:.8fr 1.2fr;gap:60px;align-items:end;margin-bottom:44px}.kicker{color:#79e9ff;text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:850}.section h2{font-size:clamp(34px,5vw,54px);line-height:1.05;letter-spacing:-.04em;margin:10px 0 0}.section-head p{color:var(--muted);margin:0;font-size:18px}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:28px;min-height:220px;border:1px solid var(--line);border-radius:22px;background:linear-gradient(150deg,#151a30cc,#0b0e1dcc);box-shadow:inset 0 1px #ffffff0c}.icon{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,#14385b,#6545bf);color:#7cecff;font-size:21px}.card h3{margin:22px 0 9px;font-size:20px}.card p{margin:0;color:var(--muted);font-size:15px}.billing{display:grid;grid-template-columns:1fr 1fr;gap:18px}.billing-card{padding:32px;border:1px solid var(--line);border-radius:24px;background:#0d1122}.billing-card.highlight{background:linear-gradient(145deg,#11243d,#171235 58%,#28102a);border-color:#57518a}.billing-card h3{margin:0 0 11px;font-size:25px}.billing-card p{color:var(--muted);margin:0}.clean-list{list-style:none;padding:0;margin:24px 0 0}.clean-list li{position:relative;padding:9px 0 9px 29px;color:#dbe1f3}.clean-list li:before{content:"\\2713";position:absolute;left:0;color:#64efcc;font-weight:900}.notice{margin-top:22px;padding:18px 20px;border-left:3px solid var(--cyan);border-radius:4px 12px 12px 4px;background:#5ae7ff0c;color:#bfc8df;font-size:14px}footer{padding:36px 0 48px;border-top:1px solid #ffffff12;display:flex;justify-content:space-between;align-items:center;gap:24px;color:#8490b1;font-size:13px}.footer-links{display:flex;gap:20px;flex-wrap:wrap}@media(max-width:820px){nav{display:none}.hero{grid-template-columns:1fr;padding-top:55px}.visual{min-height:430px}.section-head{grid-template-columns:1fr;gap:18px}.feature-grid,.billing{grid-template-columns:1fr}.feature-grid .card{min-height:0}}@media(max-width:520px){header,main,footer{width:min(100% - 28px,1160px)}header{height:70px}.brand span:last-child{font-size:14px}.hero{gap:30px;padding-bottom:64px}.visual{min-height:410px}.phone{width:255px}.section{padding:64px 0}footer{align-items:flex-start;flex-direction:column}}
</style></head><body>
<header><a class="brand" href="/genora" aria-label="Genora home"><span class="mini-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M18.7 7.7A8 8 0 1 0 19 16l-3.8-2.2a3.7 3.7 0 1 1 .3-3.3H11v3h9.9c.1-.5.1-1 .1-1.5 0-1.6-.5-3-1.3-4.3Z" fill="white"/></svg></span><span>Genora AI</span></a><nav aria-label="Primary"><a href="#features">Features</a><a href="#billing">Purchases</a></nav></header>
<main><section class="hero"><div><div class="eyebrow">Official application page</div><h1>Create beyond <span class="gradient">imagination.</span></h1><p class="lead">Genora AI Image Video Editor is an Android creative app that transforms text prompts and selected photos into AI-generated images and videos, with curated templates and practical editing tools.</p><div class="actions">${storeLink}<a class="button" href="#billing">Purchase information <span aria-hidden="true">&#8595;</span></a></div></div><div class="visual" aria-label="Illustration of the Genora mobile application"><div class="phone"><div class="screen"><div class="screen-top"><div class="screen-mark">G</div><div class="coin">&#9679; AI coins</div></div><div class="screen-copy"><b>What will you<br>create today?</b><span>Describe your idea or start from a photo.</span></div><div class="prompt">A cinematic portrait with natural detail and studio light...</div><div class="art-grid"><div class="art"></div><div class="art"></div></div><div class="generate">Generate with AI</div></div></div></div></section>
<section class="section" id="features"><div class="section-head"><div><div class="kicker">Creative toolkit</div><h2>One idea.<br>Many possibilities.</h2></div><p>Designed for adult creators who want an approachable way to produce visual concepts, portraits, motion and social content from prompts or their own media.</p></div><div class="feature-grid"><article class="card"><div class="icon" aria-hidden="true">&#10022;</div><h3>AI image creation</h3><p>Create original visual concepts from detailed text prompts with administrator-selected generation models.</p></article><article class="card"><div class="icon" aria-hidden="true">&#9654;</div><h3>AI video generation</h3><p>Turn ideas and eligible images into short generated videos using available AI video workflows.</p></article><article class="card"><div class="icon" aria-hidden="true">&#9638;</div><h3>Templates and editing</h3><p>Start faster with curated creative templates and tools for enhancing personal photos and visual projects.</p></article></div></section>
<section class="section" id="billing"><div class="section-head"><div><div class="kicker">Transparent digital purchases</div><h2>Google Play<br>handles payment.</h2></div><p>Genora offers optional digital products for creative features. Purchase prices, taxes, billing periods and confirmation are always displayed by Google Play before payment.</p></div><div class="billing"><article class="billing-card highlight"><h3>Consumable AI coins</h3><p>Coin packs are optional digital credits used only to request eligible AI image and video generations inside Genora.</p><ul class="clean-list"><li>Used only for in-app digital generation</li><li>Not transferable between users</li><li>No cash, cryptocurrency or gift-card value</li><li>Not redeemable for physical products</li></ul></article><article class="billing-card"><h3>Optional subscriptions</h3><p>Premium plans may provide benefits such as premium templates, ad-free use or additional generation allowances, subject to the plan shown in Google Play.</p><ul class="clean-list"><li>Purchased through Google Play Billing</li><li>Managed or cancelled in Google Play</li><li>No loot boxes or chance-based rewards</li><li>No external payment collection in the app</li></ul></article></div><div class="notice">Genora is not a bank, wallet, money-transfer service, investment product, gambling product, cryptocurrency service or cash-reward platform. Virtual coins cannot be withdrawn, traded or converted into money.</div></section>
</main>
<footer><span>&copy; ${new Date().getUTCFullYear()} Genora AI Image Video Editor</span><div class="footer-links"><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Use</a><a href="/account-deletion">Account deletion</a></div></footer></body></html>`;
  };
  app.get("/genora", async (_req, reply) => {
    const legal = (await getSetting(db, "published")).content.legal;
    return reply
      .type("text/html; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(appProfileDocument(legal));
  });
  app.get("/privacy", async (_req, reply) => {
    const legal = (await getSetting(db, "published")).content.legal;
    const text = legal.privacy + (legal.supportEmail ? `\n\nSupport: ${legal.supportEmail}` : "");
    return reply.type("text/html; charset=utf-8").send(legalDocument({ title: "Privacy Policy", text }));
  });
  app.get("/terms", async (_req, reply) => {
    const legal = (await getSetting(db, "published")).content.legal;
    const text = legal.terms + (legal.supportEmail ? `\n\nSupport: ${legal.supportEmail}` : "");
    return reply.type("text/html; charset=utf-8").send(legalDocument({ title: "Terms of Use", text }));
  });
  app.get("/account-deletion", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(legalDocument({
      title: "Delete your account",
      content: `<p class="note">Registered users can permanently delete their Genora account and associated server data here. You can also delete your account inside the app. Guest accounts without an email must be deleted inside the installed app.</p><form id="delete-form"><label for="email">Account email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="128"><label><input id="confirm" type="checkbox" required style="width:auto;margin-right:8px">I understand this permanently deletes my account, generation history, coins, uploads, and generated server files.</label><button id="submit" type="submit">Permanently delete account</button><p id="result" role="status" aria-live="polite"></p></form><script src="/account-deletion.js" defer></script>`,
    })),
  );
  app.get("/account-deletion.js", async (_req, reply) =>
    reply.type("application/javascript; charset=utf-8").send(`document.getElementById("delete-form").addEventListener("submit",async function(event){event.preventDefault();const button=document.getElementById("submit"),result=document.getElementById("result");button.disabled=true;result.textContent="Deleting account…";try{const response=await fetch("/api/account-deletion",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:document.getElementById("email").value,password:document.getElementById("password").value,confirmation:"DELETE"})});const body=await response.json();if(!response.ok)throw new Error(body.error||"Deletion could not be completed.");event.target.reset();result.textContent="Your account and associated server data were permanently deleted."}catch(error){result.textContent=error.message}finally{button.disabled=false}});`),
  );
  app.post(
    "/api/account-deletion",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (req) => {
      const input = parse(
        credentialsSchema.extend({ confirmation: z.literal("DELETE") }),
        req.body,
      );
      const user = await db
        .prepare("SELECT * FROM users WHERE email=? AND role='user'")
        .get(input.email);
      if (
        !user ||
        user.status !== "active" ||
        !(await verifyPassword(input.password, user.password))
      )
        fail(401, "Email or password is incorrect, or the account is unavailable.");
      await deleteUser(user.id, user.id);
      return { ok: true };
    },
  );
  app.post(
    "/api/auth/guest",
    { config: { rateLimit: { max: 15, timeWindow: "1 hour" } } },
    async () => {
      const id = randomUUID();
      await transaction(db, async () => {
        await db
          .prepare("INSERT INTO users(id,created_at) VALUES(?,?)")
          .run(id, now());
        await credit(
          db,
          id,
          (await getSetting(db, "published")).content.rewards.welcome,
          "Welcome coins",
          "welcome",
        );
      });
      return {
        session: await newSession(db, id),
        user: publicUser(
          await db.prepare("SELECT * FROM users WHERE id=?").get(id),
        ),
      };
    },
  );
  app.post(
    "/api/auth/register",
    { preHandler: mobile, config: limited },
    async (req) => {
      const input = parse(credentialsSchema, req.body);
      if (req.user.email) fail(409, "This account is already registered.");
      const password = await hashPassword(input.password);
      if (
        await db.prepare("SELECT id FROM users WHERE email=?").get(input.email)
      )
        fail(409, "This email cannot be used. Try signing in.");
      await db
        .prepare("UPDATE users SET email=?,password=? WHERE id=?")
        .run(input.email, password, req.user.id);
      return {
        user: publicUser(
          await db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id),
        ),
      };
    },
  );
  app.post("/api/auth/login", { config: limited }, async (req) => {
    const input = parse(credentialsSchema, req.body);
    const user = await db
      .prepare("SELECT * FROM users WHERE email=? AND role='user'")
      .get(input.email);
    if (
      !(await verifyPassword(input.password, user?.password)) ||
      !user ||
      user.status !== "active"
    )
      fail(
        401,
        "Email or password is incorrect, or the account is unavailable.",
      );
    return { session: await newSession(db, user.id), user: publicUser(user) };
  });
  app.post("/api/auth/logout", { preHandler: mobile }, async (req) => {
    await db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(req.user.session_hash);
    return { ok: true };
  });
  app.get("/api/me", { preHandler: mobile }, async (req) => ({
    user: publicUser(req.user),
    serverDate: new Date().toISOString().slice(0, 10),
  }));
  app.post(
    "/api/me/password",
    { preHandler: mobile, config: limited },
    async (req) => {
      const input = parse(
        z
          .object({
            currentPassword: z.string().max(128),
            newPassword: z.string().min(12).max(128),
          })
          .strict(),
        req.body,
      );
      if (
        !req.user.email ||
        !(await verifyPassword(input.currentPassword, req.user.password))
      )
        fail(401, "Current password is incorrect.");
      const password = await hashPassword(input.newPassword);
      await transaction(db, async () => {
        await db
          .prepare("UPDATE users SET password=? WHERE id=?")
          .run(password, req.user.id);
        await db
          .prepare("DELETE FROM sessions WHERE user_id=? AND hash!=?")
          .run(req.user.id, req.user.session_hash);
      });
      return { ok: true };
    },
  );
  app.delete(
    "/api/me",
    { preHandler: mobile, config: limited },
    async (req) => {
      const input = parse(
        z
          .object({
            confirmation: z.literal("DELETE"),
            password: z.string().max(128).optional(),
          })
          .strict(),
        req.body,
      );
      if (
        req.user.email &&
        !(await verifyPassword(input.password || "", req.user.password))
      )
        fail(401, "Enter your password to delete this account.");
      await deleteUser(req.user.id, req.user.id);
      return { ok: true };
    },
  );
  app.get("/api/wallet", { preHandler: mobile }, async (req) => ({
    user: publicUser(req.user),
    entries: await db
      .prepare(
        "SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 100",
      )
      .all(req.user.id),
  }));
  app.post(
    "/api/rewards/daily",
    { preHandler: mobile },
    async (req) =>
      await transaction(db, async () => {
        const config = (await getSetting(db, "published")).content;
        if (!config.features.dailyRewards || config.features.maintenance)
          fail(503, "Daily rewards are temporarily unavailable.");
        const user = await db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(req.user.id);
        const today = new Date().toISOString().slice(0, 10),
          yesterday = new Date(Date.now() - 86400000)
            .toISOString()
            .slice(0, 10);
        if (user.last_claim === today)
          return { claimed: false, amount: 0, user: publicUser(user) };
        const day = user.last_claim === yesterday ? user.streak % 7 : 0,
          amount = config.rewards.daily[day];
        await credit(db, user.id, amount, "Daily reward", "daily:" + today);
        await db
          .prepare("UPDATE users SET last_claim=?,streak=? WHERE id=?")
          .run(today, day + 1, user.id);
        return {
          claimed: true,
          amount,
          user: publicUser(
            await db.prepare("SELECT * FROM users WHERE id=?").get(user.id),
          ),
        };
      }),
  );
  app.post(
    "/api/jobs",
    {
      preHandler: mobile,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (deletingUsers.has(req.user.id))
        fail(409, "Account deletion is in progress.");
      const result = await createJob(
        db,
        req.user,
        req.headers["idempotency-key"],
        req.body,
        ready,
      );
      return reply
        .code(202)
        .send(
          await presentJob(
            await db.prepare("SELECT * FROM jobs WHERE id=?").get(result.id),
          ),
        );
    },
  );
  app.get("/api/jobs", { preHandler: mobile }, async (req) => ({
    jobs: await Promise.all(
      (
        await db
          .prepare(
            "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
          )
          .all(req.user.id)
      ).map(presentJob),
    ),
  }));
  app.get("/api/jobs/:id", { preHandler: mobile }, async (req) => {
    const job = await db
      .prepare("SELECT * FROM jobs WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!job) fail(404, "Generation not found.");
    return presentJob(job);
  });
  app.post("/api/jobs/:id/cancel", { preHandler: mobile }, async (req) => {
    const job = await db
      .prepare("SELECT * FROM jobs WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!job) fail(404, "Generation not found.");
    if (job.status !== "queued")
      fail(409, "Only a generation waiting to start can be cancelled.");
    await settleJob(
      db,
      job.id,
      "cancelled",
      null,
      "Cancelled before processing. Your coins were refunded.",
    );
    return { ok: true };
  });
  app.post(
    "/api/reports",
    {
      preHandler: mobile,
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      const input = parse(
        z
          .object({
            templateId: z.string().max(80).optional(),
            jobId: z.string().uuid().optional(),
            reason: z.string().trim().min(1).max(200),
            detail: z.string().max(2000).default(""),
          })
          .strict(),
        req.body,
      );
      if (!input.templateId && !input.jobId)
        fail(400, "Choose the generated content or template being reported.");
      if (input.jobId) {
        const job = await db
          .prepare("SELECT status FROM jobs WHERE id=? AND user_id=?")
          .get(input.jobId, req.user.id);
        if (!job || job.status !== "succeeded")
          fail(404, "Generated content was not found.");
      }
      const id = randomUUID();
      await db
        .prepare(
          "INSERT INTO reports(id,user_id,template_id,job_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          req.user.id,
          input.templateId || null,
          input.jobId || null,
          input.reason,
          input.detail,
          now(),
        );
      return reply.code(201).send({ id });
    },
  );
  app.get("/api/billing/catalog", { preHandler: mobile }, async req => {
    await billing.refreshUser(req.user);
    return billing.catalog(req.user);
  });
  app.post("/api/billing/verify", { preHandler: mobile, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    if (!play.enabled) fail(503, "Google Play billing is not configured yet. No coins were credited.");
    const input = parse(z.object({ productId: z.string().min(1).max(150), token: z.string().min(1).max(4096) }).strict(), req.body);
    const result = await billing.verify({ user: req.user, ...input });
    return { ...result, user: publicUser(await db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) };
  });
  app.post("/api/billing/notifications", async (req, reply) => {
    await play.authenticateNotification(req.headers.authorization);
    const body = parse(z.object({ message: z.object({ data: z.string().min(1).max(20000) }).passthrough() }).passthrough(), req.body);
    await billing.notification(body);
    return reply.code(204).send();
  });
  app.post(
    "/api/rewards/ad",
    { preHandler: mobile, config: { rateLimit: { max: 12, timeWindow: "1 day" } } },
    async (req) => {
      const input = parse(
        z.object({
          claimId: z.string().uuid(),
          offer: z.enum(["single", "double"]),
          verificationToken: z.string().min(16).max(8192),
        }).strict(),
        req.body,
      );
      const published = await getSetting(db, "published");
      if (!published.content.features.ads || !published.content.features.rewardedAds)
        fail(503, "Rewarded ads are currently disabled.");
      if (typeof verifyRewardedAd !== "function")
        fail(503, "Rewarded-ad verification is not configured. No coins were credited.");
      if (
        (await verifyRewardedAd({
          userId: req.user.id,
          claimId: input.claimId,
          offer: input.offer,
          token: input.verificationToken,
        })) !== true
      )
        fail(403, "The rewarded ad could not be verified. No coins were credited.");
      const today = new Date().toISOString().slice(0, 10);
      const reason = input.offer === "double" ? "Rewarded ads (2)" : "Rewarded ad";
      const dailyLimit = input.offer === "double" ? 2 : 8;
      const amount = input.offer === "double"
        ? published.content.rewards.twoAds
        : published.content.rewards.ad;
      const reference = `rewarded:${input.offer}:${input.claimId}`;
      const record = await transaction(db, async () => {
        const existing = await db.prepare("SELECT * FROM ledger WHERE user_id=? AND reference=?").get(req.user.id, reference);
        if (existing) return existing;
        const used = await db.prepare("SELECT count(*) AS n FROM ledger WHERE user_id=? AND reason=? AND created_at LIKE ?").get(req.user.id, reason, today + "%");
        if (used.n >= dailyLimit) fail(429, "Today’s rewarded-ad limit has been reached.");
        return credit(db, req.user.id, amount, reason, reference);
      });
      return {
        amount: record.amount,
        user: publicUser(await db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)),
      };
    },
  );
  // Authentication runs before multipart parsing or persistence.
  async function saveUpload(req, isPublic) {
    const used = (
      await db
        .prepare(
          "SELECT coalesce(sum(bytes),0) AS bytes FROM uploads WHERE user_id=?",
        )
        .get(req.user.id)
    ).bytes;
    if (used > 200 * 1024 * 1024) fail(413, "Media storage quota reached.");
    const part = await req.file();
    if (!part) fail(400, "Choose an image file.");
    const buffer = await part.toBuffer();
    let mediaType;
    try {
      mediaType = detectMedia(buffer);
    } catch {
      fail(400, "Only PNG, JPEG, and WebP images are supported.");
    }
    const { ext, mime, width, height } = mediaType;
    if (used + buffer.length > 200 * 1024 * 1024)
      fail(413, "Media storage quota reached.");
    const id = randomUUID(),
      filename = id + "." + ext;
    const stored = await storage.putUpload(
      filename,
      buffer,
      mime,
      isPublic,
      req.user.id,
    );
    try {
      await transaction(db, async () => {
        if (
          deletingUsers.has(req.user.id) ||
          (
            await db
              .prepare("SELECT status FROM users WHERE id=?")
              .get(req.user.id)
          )?.status !== "active"
        )
          fail(403, "Account is not available.");
        const current = (
          await db
            .prepare(
              "SELECT coalesce(sum(bytes),0) AS bytes FROM uploads WHERE user_id=?",
            )
            .get(req.user.id)
        ).bytes;
        if (current + buffer.length > 200 * 1024 * 1024)
          fail(413, "Media storage quota reached.");
        await db
          .prepare(
            "INSERT INTO uploads(id,user_id,filename,mime,bytes,public,created_at,storage,width,height) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            req.user.id,
            filename,
            mime,
            buffer.length,
            isPublic ? 1 : 0,
            now(),
            stored ? JSON.stringify(stored) : null,
            width || null,
            height || null,
          );
      });
    } catch (error) {
      await storage.deleteUpload({
        filename,
        storage: stored ? JSON.stringify(stored) : null,
      });
      throw error;
    }
    if (isPublic)
      await audit(db, req.user.id, "media.upload", id, {
        bytes: buffer.length,
      });
    return {
      id,
      url: isPublic ? "/media/" + filename : "/api/uploads/" + id,
      mime,
      bytes: buffer.length,
    };
  }
  app.post(
    "/api/uploads",
    {
      onRequest: mobile,
      config: { rateLimit: { max: 40, timeWindow: "1 hour" } },
    },
    async (req) => saveUpload(req, false),
  );
  app.get("/api/uploads/:id", { preHandler: mobile }, async (req, reply) => {
    const upload = await db
      .prepare("SELECT * FROM uploads WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!upload) fail(404, "Photo not found.");
    return reply.type(upload.mime).send(await storage.read(upload));
  });
  app.delete("/api/uploads/:id", { preHandler: mobile }, async (req) => {
    const upload = await db
      .prepare("SELECT * FROM uploads WHERE id=? AND user_id=? AND public=0")
      .get(req.params.id, req.user.id);
    if (!upload) fail(404, "Photo not found.");
    const active = await db
      .prepare(
        "SELECT request FROM jobs WHERE user_id=? AND status IN ('queued','processing')",
      )
      .all(req.user.id);
    if (active.some((j) => JSON.parse(j.request).uploadIds.includes(upload.id)))
      fail(409, "This photo is being used by a generation.");
    await storage.deleteUpload(upload);
    await db.prepare("DELETE FROM uploads WHERE id=?").run(upload.id);
    return { ok: true };
  });
  app.get("/media/:filename", async (req, reply) => {
    const upload = await db
      .prepare("SELECT * FROM uploads WHERE filename=? AND public=1")
      .get(req.params.filename);
    if (!upload) fail(404, "Image not found.");
    return reply
      .header("Cache-Control", "public,max-age=31536000,immutable")
      .type(upload.mime)
      .send(await storage.read(upload));
  });
  app.post("/api/admin/login", { config: limited }, async (req, reply) => {
    const input = parse(adminCredentialsSchema, req.body);
    const user = await db
      .prepare("SELECT * FROM users WHERE email=? AND role='admin'")
      .get(input.email);
    if (
      !(await verifyPassword(input.password, user?.password)) ||
      !user ||
      user.status !== "active"
    )
      fail(401, "Login ID or password is incorrect.");
    const session = await newSession(db, user.id, true);
    reply.setCookie("admin_session", session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: production,
      path: "/api/admin",
      maxAge: 43200,
    });
    await audit(db, user.id, "admin.login", user.id);
    return { user: publicUser(user), csrf: session.csrf };
  });
  app.get("/api/admin/session", { preHandler: admin }, async (req) => ({
    user: publicUser(req.user),
    csrf: req.user.csrf,
  }));
  app.post("/api/admin/logout", { preHandler: admin }, async (req, reply) => {
    await db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(req.user.session_hash);
    reply.clearCookie("admin_session", { path: "/api/admin" });
    return { ok: true };
  });
  app.post(
    "/api/admin/password",
    { preHandler: admin, config: limited },
    async (req) => {
      const input = parse(
        z
          .object({
            currentPassword: z.string().max(128),
            newPassword: z.string().min(12).max(128),
          })
          .strict(),
        req.body,
      );
      if (!(await verifyPassword(input.currentPassword, req.user.password)))
        fail(401, "Current password is incorrect.");
      const password = await hashPassword(input.newPassword);
      await transaction(db, async () => {
        await db
          .prepare("UPDATE users SET password=? WHERE id=?")
          .run(password, req.user.id);
        await db
          .prepare("DELETE FROM sessions WHERE user_id=? AND hash!=?")
          .run(req.user.id, req.user.session_hash);
        await audit(db, req.user.id, "admin.password", req.user.id);
      });
      return { ok: true };
    },
  );
  app.get("/api/admin/overview", { preHandler: admin }, async () => ({
    users: (
      await db
        .prepare("SELECT count(*) AS n FROM users WHERE role='user'")
        .get()
    ).n,
    jobs: (await db.prepare("SELECT count(*) AS n FROM jobs").get()).n,
    pending: (
      await db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','processing')",
        )
        .get()
    ).n,
    coins: (
      await db
        .prepare(
          "SELECT coalesce(sum(coins),0) AS n FROM users WHERE role='user'",
        )
        .get()
    ).n,
    reports: (
      await db
        .prepare("SELECT count(*) AS n FROM reports WHERE status='open'")
        .get()
    ).n,
    templates: (await getSetting(db, "published")).content.templates.filter(
      (t) => t.enabled,
    ).length,
    activity: await db
      .prepare(
        "SELECT substr(created_at,1,10) AS date,count(*) AS count FROM jobs GROUP BY date ORDER BY date DESC LIMIT 14",
      )
      .all(),
    recent: await db
      .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 8")
      .all(),
    publishedVersion: (await getSetting(db, "published")).version,
    services: (await configEnvelope()).services,
  }));
  app.get("/api/admin/content", { preHandler: admin }, async () => ({
    draft: await getSetting(db, "draft"),
    published: await getSetting(db, "published"),
  }));
  app.put("/api/admin/content", { preHandler: admin }, async (req) => {
    const input = parse(
      z.object({ version: z.number().int(), content: configSchema }).strict(),
      req.body,
    );
    return await transaction(db, async () => {
      const old = await getSetting(db, "draft");
      if (old.version !== input.version)
        fail(
          409,
          "Another administrator saved changes. Reload before editing.",
        );
      const draft = { version: old.version + 1, content: input.content };
      await setSetting(db, "draft", draft);
      await audit(db, req.user.id, "content.save", "draft", {
        version: draft.version,
      });
      return { draft };
    });
  });
  app.post("/api/admin/content/publish", { preHandler: admin }, async (req) => {
    const input = parse(
      z
        .object({
          version: z.number().int(),
          note: z.string().trim().min(1).max(300),
        })
        .strict(),
      req.body,
    );
    return await transaction(db, async () => {
      const draft = await getSetting(db, "draft");
      if (draft.version !== input.version)
        fail(409, "The draft changed. Reload and review it before publishing.");
      parse(configSchema, draft.content);
      const r = await db
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run(JSON.stringify(draft.content), input.note, req.user.id, now());
      const published = {
        version: Number(r.lastInsertRowid),
        content: draft.content,
      };
      await setSetting(db, "published", published);
      // Advance the draft too, so duplicate publish requests and stale editors conflict.
      await setSetting(db, "draft", { ...draft, version: draft.version + 1 });
      await audit(
        db,
        req.user.id,
        "content.publish",
        String(published.version),
        {
          note: input.note,
        },
      );
      return { published, draft: await getSetting(db, "draft") };
    });
  });
  app.get("/api/admin/revisions", { preHandler: admin }, async () => ({
    revisions: await db
      .prepare(
        "SELECT id,note,actor,created_at FROM revisions ORDER BY id DESC LIMIT 100",
      )
      .all(),
  }));
  app.post(
    "/api/admin/revisions/:id/restore",
    { preHandler: admin },
    async (req) => {
      const input = parse(
        z.object({ version: z.number().int() }).strict(),
        req.body,
      );
      const rev = await db
        .prepare("SELECT * FROM revisions WHERE id=?")
        .get(req.params.id);
      if (!rev) fail(404, "Revision not found.");
      const content = parse(configSchema, JSON.parse(rev.content));
      return await transaction(db, async () => {
        const old = await getSetting(db, "draft");
        if (old.version !== input.version)
          fail(409, "Draft changed. Reload before restoring.");
        const draft = { version: old.version + 1, content };
        await setSetting(db, "draft", draft);
        await audit(db, req.user.id, "content.restore", String(rev.id));
        return { draft };
      });
    },
  );
  function paging(query) {
    return parse(
      z.object({
        q: z.string().max(200).default(""),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      }),
      query,
    );
  }
  app.get("/api/admin/users", { preHandler: admin }, async (req) => {
    const { q, page } = paging(req.query),
      needle = "%" + q + "%";
    return {
      users: (
        await db
          .prepare(
            "SELECT * FROM users WHERE role='user' AND (id LIKE ? OR coalesce(email,'') LIKE ?) ORDER BY created_at DESC LIMIT 30 OFFSET ?",
          )
          .all(needle, needle, (page - 1) * 30)
      ).map(publicUser),
      total: (
        await db
          .prepare(
            "SELECT count(*) AS n FROM users WHERE role='user' AND (id LIKE ? OR coalesce(email,'') LIKE ?)",
          )
          .get(needle, needle)
      ).n,
      page,
    };
  });
  app.get("/api/admin/users/:id", { preHandler: admin }, async (req) => {
    const user = await db
      .prepare("SELECT * FROM users WHERE id=? AND role='user'")
      .get(req.params.id);
    if (!user) fail(404, "User not found.");
    return {
      user: publicUser(user),
      ledger: await db
        .prepare(
          "SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 100",
        )
        .all(user.id),
      jobs: await Promise.all(
        (
          await db
            .prepare(
              "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
            )
            .all(user.id)
        ).map(presentJob),
      ),
    };
  });
  app.patch("/api/admin/users/:id", { preHandler: admin }, async (req) => {
    const input = parse(
      z.object({ status: z.enum(["active", "suspended"]) }).strict(),
      req.body,
    );
    const user = await db
      .prepare("SELECT * FROM users WHERE id=? AND role='user'")
      .get(req.params.id);
    if (!user) fail(404, "User not found.");
    await transaction(db, async () => {
      await db
        .prepare("UPDATE users SET status=? WHERE id=?")
        .run(input.status, user.id);
      if (input.status === "suspended")
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      await audit(db, req.user.id, "user.status", user.id, input);
    });
    return { ok: true };
  });
  app.post("/api/admin/users/:id/coins", { preHandler: admin }, async (req) => {
    const input = parse(
      z
        .object({
          amount: z
            .number()
            .int()
            .min(-1000000)
            .max(1000000)
            .refine((v) => v !== 0),
          reason: z.string().trim().min(5).max(300),
          requestId: z.string().uuid(),
        })
        .strict(),
      req.body,
    );
    if (
      !(await db
        .prepare("SELECT id,status FROM users WHERE id=? AND role='user'")
        .get(req.params.id))
    )
      fail(404, "User not found.");
    return await transaction(db, async () => {
      const reference = "admin:" + input.requestId;
      const old = await db
        .prepare("SELECT * FROM ledger WHERE user_id=? AND reference=?")
        .get(req.params.id, reference);
      if (old && (old.amount !== input.amount || old.reason !== input.reason))
        fail(409, "Adjustment request was already used with different values.");
      const entry = await credit(
        db,
        req.params.id,
        input.amount,
        input.reason,
        reference,
      );
      if (!old)
        await audit(db, req.user.id, "wallet.adjust", req.params.id, {
          amount: input.amount,
          reason: input.reason,
          entryId: entry.id,
        });
      return { entry };
    });
  });
  async function deleteUser(id, actor) {
    if (deletingUsers.has(id))
      fail(409, "Account deletion is already in progress.");
    deletingUsers.add(id);
    let previousStatus;
    try {
      await transaction(db, async () => {
        const user = await db
          .prepare("SELECT status FROM users WHERE id=? AND role='user'")
          .get(id);
        if (!user) fail(404, "User not found.");
        if (
          await db
            .prepare(
              "SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','processing')",
            )
            .get(id)
        )
          fail(
            409,
            "Wait for active generations to finish before deleting the account.",
          );
        previousStatus = user.status.replace(/^deleting:/, "");
        await db
          .prepare("UPDATE users SET status=? WHERE id=?")
          .run("deleting:" + previousStatus, id);
      });
      const uploads = await db
        .prepare("SELECT * FROM uploads WHERE user_id=? AND public=0")
        .all(id);
      for (const upload of uploads) await storage.deleteUpload(upload);
      const results = await db
        .prepare(
          "SELECT result_media FROM jobs WHERE user_id=? AND result_media IS NOT NULL",
        )
        .all(id);
      for (const result of results)
        await storage.deleteObject(JSON.parse(result.result_media));
      await transaction(db, async () => {
        await db.prepare("DELETE FROM users WHERE id=?").run(id);
        await audit(db, actor, "user.delete", id);
      });
    } catch (error) {
      if (previousStatus)
        await db
          .prepare(
            "UPDATE users SET status=? WHERE id=? AND status LIKE 'deleting:%'",
          )
          .run(previousStatus, id);
      throw error;
    } finally {
      deletingUsers.delete(id);
    }
  }
  app.delete("/api/admin/users/:id", { preHandler: admin }, async (req) => {
    parse(z.object({ confirmation: z.literal("DELETE") }).strict(), req.body);
    await deleteUser(req.params.id, req.user.id);
    return { ok: true };
  });
  app.get("/api/admin/jobs", { preHandler: admin }, async (req) => {
    const { q, page } = paging(req.query),
      needle = "%" + q + "%";
    const rows = await db
      .prepare(
        "SELECT * FROM jobs WHERE id LIKE ? OR user_id LIKE ? OR status LIKE ? ORDER BY created_at DESC LIMIT 30 OFFSET ?",
      )
      .all(needle, needle, needle, (page - 1) * 30);
    return {
      jobs: await Promise.all(
        rows.map(async (j) => ({
          ...(await presentJob(j)),
          userId: j.user_id,
          attempts: j.attempts,
        })),
      ),
      total: (
        await db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE id LIKE ? OR user_id LIKE ? OR status LIKE ?",
          )
          .get(needle, needle, needle)
      ).n,
      page,
    };
  });
  app.post("/api/admin/jobs/:id/cancel", { preHandler: admin }, async (req) => {
    const job = await db
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(req.params.id);
    if (!job) fail(404, "Job not found.");
    if (job.status !== "queued")
      fail(409, "Only jobs that have not started can be cancelled.");
    await settleJob(
      db,
      job.id,
      "cancelled",
      null,
      "Cancelled by an administrator. Coins refunded.",
    );
    await audit(db, req.user.id, "job.cancel", job.id);
    return { ok: true };
  });
  app.get("/api/admin/reports", { preHandler: admin }, async () => {
    const reports = await db
      .prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT 200")
      .all();
    return {
      reports: await Promise.all(reports.map(async (report) => {
        const job = report.job_id
          ? await db.prepare("SELECT * FROM jobs WHERE id=?").get(report.job_id)
          : null;
        const result = job ? await presentJob(job) : null;
        return {
          ...report,
          jobMode: result?.mode || null,
          jobStatus: result?.status || null,
          resultUrl: result?.resultUrl || null,
        };
      })),
    };
  });
  app.patch("/api/admin/reports/:id", { preHandler: admin }, async (req) => {
    const input = parse(
      z.object({ status: z.enum(["open", "reviewing", "resolved"]) }).strict(),
      req.body,
    );
    if (
      !(
        await db
          .prepare("UPDATE reports SET status=? WHERE id=?")
          .run(input.status, req.params.id)
      ).changes
    )
      fail(404, "Report not found.");
    await audit(db, req.user.id, "report.status", req.params.id, input);
    return { ok: true };
  });
  app.get("/api/admin/media", { preHandler: admin }, async () => ({
    media: (
      await db
        .prepare(
          "SELECT id,filename,mime,bytes,created_at FROM uploads WHERE public=1 ORDER BY created_at DESC LIMIT 300",
        )
        .all()
    ).map((m) => ({ ...m, url: "/media/" + m.filename })),
  }));
  app.post("/api/admin/media", { onRequest: admin }, async (req) =>
    saveUpload(req, true),
  );
  app.delete("/api/admin/media/:id", { preHandler: admin }, async (req) => {
    const media = await db
      .prepare("SELECT * FROM uploads WHERE id=? AND public=1")
      .get(req.params.id);
    if (!media) fail(404, "Image not found.");
    const used =
      JSON.stringify(await getSetting(db, "draft")).includes(media.filename) ||
      (await db
        .prepare("SELECT 1 FROM revisions WHERE instr(content,?)>0")
        .get(media.filename));
    if (used)
      fail(
        409,
        "This image is referenced by a draft or published revision. Keep it to preserve version history.",
      );
    await storage.deleteUpload(media);
    await db.prepare("DELETE FROM uploads WHERE id=?").run(media.id);
    await audit(db, req.user.id, "media.delete", media.id);
    return { ok: true };
  });
  app.get("/api/admin/integration", { preHandler: admin }, async () => {
    const saved = await getSetting(db, "integration");
    const { secret, ...rawSettings } = saved;
    const settings = rawSettings.provider === "fal"
      ? normalizeFalSettings(rawSettings)
      : rawSettings;
    return {
      ...settings,
      hasKey: settings.provider === "fal" ? !!falKey : !!secret,
      ...(settings.provider === "fal"
        ? {
          falModels,
          imageCatalog: falImageCatalog,
          imageSizes: falImageSizes,
          pricingChecked: falImageCatalog.pricingChecked,
          keySource: "environment",
          output: {
            imageSize: "Admin-selected size for text generation; source aspect for edits",
            video: "720p model · requested 5.4 seconds",
            perRequest: 1,
          },
        }
        : {}),
      allowedHosts,
      services: (await configEnvelope()).services,
      billing: play.enabled ? "configured" : "not_configured",
      ads:
        (await getSetting(db, "published")).content.features.ads &&
          typeof verifyRewardedAd === "function"
          ? "enabled"
          : "disabled",
    };
  });
  app.put("/api/admin/integration", { preHandler: admin }, async (req) => {
    const input = parse(
      z
        .object({
          settings: integrationSchema,
          apiKey: z.string().min(1).max(4096).optional(),
          removeKey: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    if (input.settings.provider === "fal") {
      if (input.apiKey || input.removeKey)
        fail(400, "Set FAL_KEY in the backend environment.");
      if (input.settings.enabled && (!falKey || storage.mode !== "r2"))
        fail(400, "Configure FAL_KEY and R2 before enabling fal.");
      if (
        await db
          .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
          .get()
      )
        fail(409, "Wait for active jobs before changing provider settings.");
      const imageModel = input.settings.models.image;
      const editModel = input.settings.models.edit;
      if (!isFalImageModel("image", imageModel))
        fail(400, "Choose a supported image generation model.");
      if (!isFalImageModel("edit", editModel))
        fail(400, "Choose a supported image editing model.");
      const settings = normalizeFalSettings(input.settings);
      await setSetting(db, "integration", settings);
      await audit(db, req.user.id, "integration.update", "fal", {
        enabled: settings.enabled,
        imageModel: settings.models.image,
        editModel: settings.models.edit,
        imageSize: settings.imageSize,
      });
      return { ok: true };
    }
    if (input.settings.gatewayUrl)
      validateGatewayUrl(input.settings.gatewayUrl, allowedHosts);
    const old = await getSetting(db, "integration"),
      secret = input.removeKey
        ? null
        : input.apiKey
          ? encrypt(input.apiKey, key)
          : old.secret;
    if (input.settings.enabled && (!secret || !input.settings.gatewayUrl))
      fail(400, "Set a gateway URL and API key before enabling generation.");
    if (
      await db
        .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
        .get()
    )
      fail(409, "Wait for active jobs before changing provider credentials.");
    await setSetting(db, "integration", { ...input.settings, secret });
    await audit(db, req.user.id, "integration.update", "ai", {
      enabled: input.settings.enabled,
      keyChanged: !!input.apiKey || !!input.removeKey,
    });
    return { ok: true };
  });
  app.get("/api/admin/audit", { preHandler: admin }, async (req) => {
    const { page } = paging(req.query);
    return {
      entries: await db
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 50 OFFSET ?")
        .all((page - 1) * 50),
      total: (await db.prepare("SELECT count(*) AS n FROM audit").get()).n,
      page,
    };
  });
  app.get("/api/admin/purchases", { preHandler: admin }, async () => ({
    configured: play.enabled,
    notificationsReady: play.notificationsReady,
    purchases: await db
      .prepare("SELECT * FROM purchases ORDER BY created_at DESC LIMIT 100")
      .all(),
  }));
  const dist = resolve(
    options.frontendDist ||
    process.env.FRONTEND_DIST ||
    fileURLToPath(new URL("../../frontend/dist", import.meta.url)),
  );
  if (existsSync(dist))
    await app.register(staticFiles, { root: dist, prefix: "/" });
  app.get("/seed-assets/:name", async (req, reply) => {
    if (!bundledNames.includes(req.params.name)) fail(404, "Asset not found.");
    const media = (await getSetting(db, "bundled_media"))?.[req.params.name];
    return reply
      .type("image/png")
      .header("Cache-Control", "public,max-age=86400")
      .send(
        media
          ? await storage.read({ storage: JSON.stringify(media) })
          : createReadStream(bundledPath(req.params.name)),
      );
  });
  app.setNotFoundHandler((req, reply) => {
    if (
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/media/") &&
      existsSync(join(dist, "index.html"))
    )
      return reply
        .type("text/html")
        .send(readFileSync(join(dist, "index.html")));
    return reply.code(404).send({ error: "Route not found." });
  });
  const genericGateway = createGateway({ db, key, storage, allowedHosts });
  const falGateway = createFalGateway({
    db,
    storage,
    apiKey: falKey,
    request: options.falRequest,
  });
  const worker = createWorker({
    db,
    gateway: options.gateway || {
      run: (job, config) =>
        (config.provider === "fal" ? falGateway : genericGateway).run(
          job,
          config,
        ),
    },
    storage,
    logger: app.log,
    autoStart: options.worker !== false,
  });
  app.decorate("worker", worker);
  let billingRun = null;
  const billingTimer = play.enabled && options.worker !== false
    ? setInterval(() => {
      if (!billingRun) billingRun = billing.reconcile().catch(() => app.log.warn("Billing reconciliation will retry.")).finally(() => { billingRun = null; });
    }, 60000) : null;
  billingTimer?.unref();
  app.addHook("onClose", async () => {
    if (billingTimer) clearInterval(billingTimer);
    await billingRun;
    await worker.stop();
    storage.close?.();
    if (!options.db) await db.close();
  });
  return app;
}
