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
import { createFalGateway, falModels, falSettings } from "./fal.mjs";
import { createJob, publicJob, settleJob, createWorker } from "./jobs.mjs";
import { createPlayBilling } from "./play-billing.mjs";
import { createBilling } from "./billing.mjs";
export async function buildApp(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || "./data");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const db =
    options.db || (await connectDatabase(join(dataDir, "studio.sqlite")));
  const key = masterKey(dataDir);
  const play = options.playBilling || createPlayBilling();
  const billing = createBilling({ db, play, key });
  const storage = options.storage || createStorage({ dataDir });
  const falKey = options.falKey ?? process.env.FAL_KEY?.trim();
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
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
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
    return {
      ...published,
      content,
      services: {
        image: ready(integration, "image"),
        video: ready(integration, "video"),
        dance: ready(integration, "dance"),
        slideshow: ready(integration, "slideshow"),
        billing: play.enabled,
        ads: false,
      },
      serverDate: new Date().toISOString().slice(0, 10),
    };
  }
  app.get("/api/config", async () => await configEnvelope());
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
            reason: z.string().trim().min(1).max(200),
            detail: z.string().max(2000).default(""),
          })
          .strict(),
        req.body,
      );
      const id = randomUUID();
      await db
        .prepare(
          "INSERT INTO reports(id,user_id,template_id,reason,detail,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          req.user.id,
          input.templateId || null,
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
  app.post("/api/billing/verify", { preHandler: mobile, config: {rateLimit:{max:60,timeWindow:'1 minute'}} }, async req => {
    if (!play.enabled) fail(503, "Google Play billing is not configured yet. No coins were credited.");
    const input = parse(z.object({ productId: z.string().min(1).max(150), token: z.string().min(1).max(4096) }).strict(), req.body);
    const result = await billing.verify({user: req.user, ...input});
    return {...result, user: publicUser(await db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id))};
  });
  app.post("/api/billing/notifications", async (req, reply) => {
    await play.authenticateNotification(req.headers.authorization);
    const body = parse(z.object({message: z.object({data: z.string().min(1).max(20000)}).passthrough()}).passthrough(), req.body);
    await billing.notification(body);
    return reply.code(204).send();
  });
  app.post("/api/rewards/ad", { preHandler: mobile }, async () =>
    fail(
      503,
      "Verified rewarded ads are not configured. No coins were credited.",
    ),
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
    const { ext, mime } = mediaType;
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
            "INSERT INTO uploads(id,user_id,filename,mime,bytes,public,created_at,storage) VALUES(?,?,?,?,?,?,?,?)",
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
  app.get("/api/admin/reports", { preHandler: admin }, async () => ({
    reports: await db
      .prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT 200")
      .all(),
  }));
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
    const { secret, ...settings } = await getSetting(db, "integration");
    return {
      ...settings,
      hasKey: settings.provider === "fal" ? !!falKey : !!secret,
      ...(settings.provider === "fal"
        ? {
            falModels,
            keySource: "environment",
            output: {
              imageSize: "960 × 960",
              video: "720p model · requested 5.4 seconds",
              perRequest: 1,
            },
          }
        : {}),
      allowedHosts,
      services: (await configEnvelope()).services,
      billing: play.enabled ? "configured" : "not_configured",
      ads: "not_configured",
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
      await setSetting(db, "integration", {
        ...falSettings,
        enabled: input.settings.enabled,
      });
      await audit(db, req.user.id, "integration.update", "fal", {
        enabled: input.settings.enabled,
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
    configured: false,
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
        if (!billingRun) billingRun = billing.reconcile().catch(() => app.log.warn("Billing reconciliation will retry.")).finally(() => {billingRun = null;});
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
