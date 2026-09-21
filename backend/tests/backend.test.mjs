import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStorage } from "../server/storage.mjs";
import { buildApp } from "../server/app.mjs";
import { bundledNames, migrateBundledMedia } from "../server/bundled-media.mjs";
import {
  openDatabase,
  openPostgresDatabase,
  now,
  transaction,
  credit,
  getSetting,
  setSetting,
} from "../server/db.mjs";
import { hashPassword } from "../server/security.mjs";
import { settleJob } from "../server/jobs.mjs";
import {
  publicIPv4,
  validateGatewayUrl,
  safeResultUrl,
} from "../server/gateway.mjs";
async function fixture(
  t,
  { gateway, storage: makeStorage, falKey, falRequest } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ai-studio-test-"));
  let db;
  let cleanupDatabase = async () => {};
  if (process.env.TEST_POSTGRES_URL) {
    const { postgresDriver } = await import("../server/database-driver.mjs");
    const control = postgresDriver(process.env.TEST_POSTGRES_URL);
    const schema = "test_" + randomUUID().replaceAll("-", "");
    await control.exec("CREATE SCHEMA " + schema);
    const url = new URL(process.env.TEST_POSTGRES_URL);
    url.searchParams.set("options", "-c search_path=" + schema);
    db = await openPostgresDatabase(url.href);
    cleanupDatabase = async () => {
      await control.exec("DROP SCHEMA " + schema + " CASCADE");
      await control.close();
    };
  } else db = await openDatabase(join(dir, "studio.sqlite"));
  const adminId = randomUUID();
  await db
    .prepare(
      "INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,'admin',?)",
    )
    .run(
      adminId,
      "owner@example.com",
      await hashPassword("test-password-12345"),
      now(),
    );
  const storage = makeStorage
    ? makeStorage(dir)
    : createStorage({ dataDir: dir, env: { MEDIA_STORAGE: "local" } });
  const app = await buildApp({
    dataDir: dir,
    storage,
    db,
    logger: false,
    worker: false,
    gateway,
    falKey,
    falRequest,
    allowedHosts: "gateway.example.com",
  });
  t.after(async () => {
    await app.close();
    await db.close();
    await cleanupDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = "http://localhost:4000";
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { origin },
    payload: { email: "owner@example.com", password: "test-password-12345" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const headers = {
    origin,
    cookie: login.cookies[0].name + "=" + login.cookies[0].value,
    "x-csrf-token": login.json().csrf,
  };
  const admin = (url, method = "GET", payload) =>
    app.inject({ url: "/api/admin" + url, method, headers, payload });
  const guest = async () => {
    const result = (
      await app.inject({ url: "/api/auth/guest", method: "POST", payload: {} })
    ).json();
    return {
      user: result.user,
      call: (url, method = "GET", payload, extra = {}) =>
        app.inject({
          url,
          method,
          payload,
          headers: {
            authorization: "Bearer " + result.session.token,
            ...extra,
          },
        }),
    };
  };
  return { app, db, admin, guest, headers, adminId, storage, dir };
}
test("admin reset supports username login, preserves the account, and revokes old sessions", async (t) => {
  const { resetAdmin } = await import("../server/admin-reset.mjs");
  const { verifyPassword } = await import("../server/security.mjs");
  const { app, db, admin, adminId, guest, headers } = await fixture(t);
  const other = await guest();
  await db.prepare("UPDATE users SET status='suspended',coins=25 WHERE id=?").run(adminId);
  await resetAdmin(db, { login: "Admin", password: "admin@123" });
  const account = await db.prepare("SELECT * FROM users WHERE id=?").get(adminId);
  assert.equal(account.email, "admin");
  assert.equal(account.role, "admin");
  assert.equal(account.status, "active");
  assert.equal(account.coins, 25);
  assert.notEqual(account.password, "admin@123");
  assert.equal(await verifyPassword("admin@123", account.password), true);
  assert.equal((await admin("/overview")).statusCode, 401);
  assert.equal((await other.call("/api/me")).statusCode, 200);
  const login = (email, password) => app.inject({
    method: "POST", url: "/api/admin/login", headers: { origin: headers.origin },
    payload: { email, password },
  });
  assert.equal((await login("owner@example.com", "test-password-12345")).statusCode, 401);
  assert.equal((await login("admin", "incorrect-password")).statusCode, 401);
  const response = await login(" ADMIN ", "admin@123");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().user.id, adminId);
  assert.equal(response.cookies[0].httpOnly, true);
  const log = await db.prepare("SELECT * FROM audit WHERE action='admin.credentials.reset'").get();
  assert.equal(log.actor, adminId);
  assert.equal(log.detail.includes("admin@123"), false);
});

test("admin reset refuses conflicting logins and ambiguous administrators", async (t) => {
  const { resetAdmin } = await import("../server/admin-reset.mjs");
  const { db, adminId, admin } = await fixture(t);
  const original = await db.prepare("SELECT * FROM users WHERE id=?").get(adminId);
  await db.prepare("INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,'user',?)")
    .run(randomUUID(), "admin", "unused", now());
  await assert.rejects(resetAdmin(db, { login: "admin", password: "admin@123" }), /belongs to another account/);
  assert.deepEqual(await db.prepare("SELECT * FROM users WHERE id=?").get(adminId), original);
  assert.equal((await admin("/overview")).statusCode, 200);
  await db.prepare("INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,'admin',?)")
    .run(randomUUID(), "second@example.com", "unused", now());
  await assert.rejects(resetAdmin(db, { login: "owner", password: "admin@123" }), /Multiple administrators/);
  await resetAdmin(db, { login: "owner", password: "admin@123", currentLogin: "owner@example.com" });
  assert.equal((await db.prepare("SELECT email FROM users WHERE id=?").get(adminId)).email, "owner");
  await assert.rejects(resetAdmin(db, { login: "owner", password: "admin@123", currentLogin: "missing" }), /No matching administrator/);
  await assert.rejects(resetAdmin(db, { login: "owner", password: "short" }), /8 to 128/);
});

test("bundled images retain their URLs after verified R2 migration and reruns", async (t) => {
  const { fakeR2 } = await import("./helpers/r2.mjs");
  const r2 = fakeR2();
  const { app, db, storage } = await fixture(t, { storage: r2.storage });
  const originals = new Map();
  for (const name of bundledNames) {
    const response = await app.inject("/seed-assets/" + name);
    assert.equal(response.statusCode, 200);
    originals.set(name, response.rawPayload);
  }
  r2.state.failPut = true;
  await assert.rejects(migrateBundledMedia(db, storage));
  assert.equal(await getSetting(db, "bundled_media"), null);
  r2.state.failPut = false;
  assert.equal(await migrateBundledMedia(db, storage), bundledNames.length);
  assert.equal(await migrateBundledMedia(db, storage), 0);
  assert.equal(r2.files.size, bundledNames.length);
  for (const name of bundledNames) {
    const response = await app.inject("/seed-assets/" + name);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, originals.get(name));
    assert.equal(response.headers["content-type"], "image/png");
  }
  assert.equal((await app.inject("/seed-assets/unknown.png")).statusCode, 404);
});
test("admin auth, origin checks, CSRF, cookie protection, and public secret exclusion", async (t) => {
  const { app, admin, headers } = await fixture(t);
  assert.equal((await app.inject("/api/admin/overview")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/api/admin/logout",
        method: "POST",
        headers: { cookie: headers.cookie, origin: headers.origin },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/admin/logout",
        method: "POST",
        headers: { ...headers, origin: "https://evil.example" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  const saved = await admin("/integration", "PUT", {
    settings: {
      enabled: false,
      gatewayUrl: "https://gateway.example.com/v1",
      models: { image: "image-v1", video: "", dance: "", slideshow: "" },
    },
    apiKey: "a-very-secret-key",
  });
  assert.equal(saved.statusCode, 200, saved.body);
  for (const path of [
    "/api/config",
    "/api/admin/integration",
    "/api/admin/audit",
  ]) {
    const response = await app.inject({ url: path, headers });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes("a-very-secret-key"));
  }
  const session = await admin("/session");
  assert.ok(session.json().csrf);
  await admin("/logout", "POST", {});
  assert.equal((await admin("/session")).statusCode, 401);
});
test("draft isolation, validation, stale write conflict, publish, and restore", async (t) => {
  const { app, admin, db } = await fixture(t);
  const before = (await app.inject("/api/config")).json();
  const original = (await admin("/content")).json().draft;
  original.content.texts.Home = "Discover";
  original.content.costs.image = 65;
  const draft = (await admin("/content", "PUT", original)).json().draft;
  assert.equal(
    (await app.inject("/api/config")).json().content.costs.image,
    before.content.costs.image,
  );
  assert.equal((await admin("/content", "PUT", original)).statusCode, 409);
  const invalid = structuredClone(draft);
  invalid.content.costs.image = -5;
  assert.equal((await admin("/content", "PUT", invalid)).statusCode, 400);
  const pub = await admin("/content/publish", "POST", {
    version: draft.version,
    note: "Change image price and Home label",
  });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.equal(
    (await app.inject("/api/config")).json().content.texts.Home,
    "Discover",
  );
  assert.equal((await getSetting(db, "published")).content.costs.image, 65);
  assert.equal(
    (
      await admin("/content/publish", "POST", {
        version: draft.version,
        note: "Duplicate",
      })
    ).statusCode,
    409,
  );
  const restored = await admin("/revisions/1/restore", "POST", {
    version: pub.json().draft.version,
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().draft.content.costs.image, 40);
  assert.equal(
    (await app.inject("/api/config")).json().content.costs.image,
    65,
  );
});
test("concurrent daily claims credit once and use server reward amounts", async (t) => {
  const { guest, db } = await fixture(t),
    g = await guest();
  const published = await getSetting(db, "published");
  published.content.rewards.daily[0] = 17;
  await setSetting(db, "published", published);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => g.call("/api/rewards/daily", "POST", {})),
  );
  assert.equal(responses.filter((r) => r.json().claimed).length, 1);
  assert.equal((await g.call("/api/me")).json().user.coins, 30);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM ledger WHERE reason='Daily reward'")
        .get()
    ).n,
    1,
  );
});
test("unconfigured generation and billing cannot change coins; rewarded ads use server amounts", async (t) => {
  const { guest } = await fixture(t),
    g = await guest();
  for (const path of ["/api/jobs", "/api/billing/verify"]) {
    const response = await g.call(
      path,
      "POST",
      path === "/api/jobs"
        ? { mode: "image", prompt: "A flower" }
        : { coins: 999999 },
      { "Idempotency-Key": randomUUID() },
    );
    assert.equal(response.statusCode, 503, response.body);
  }
  assert.equal((await g.call("/api/me")).json().user.coins, 13);
  const reward = await g.call(
    "/api/rewards/ad",
    "POST",
    { claimId: randomUUID(), offer: "single" },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(reward.statusCode, 200, reward.body);
  assert.equal(reward.json().amount, 5);
  assert.equal((await g.call("/api/me")).json().user.coins, 18);
});
test("job idempotency, insufficient funds, ownership, failure refunds, and duplicate settlement", async (t) => {
  const { guest, db } = await fixture(t, {
    gateway: { run: async () => ({ status: "failed" }) },
  });
  const a = await guest(),
    b = await guest();
  await transaction(
    db,
    async () => await credit(db, a.user.id, 87, "Test funds", "test"),
  );
  const idempotency = randomUUID(),
    input = { mode: "image", prompt: "A realistic flower" };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      a.call("/api/jobs", "POST", input, { "Idempotency-Key": idempotency }),
    ),
  );
  for (const r of results) assert.equal(r.statusCode, 202, r.body);
  const id = results[0].json().id;
  assert.ok(results.every((r) => r.json().id === id));
  assert.equal((await a.call("/api/me")).json().user.coins, 60);
  assert.equal(
    (
      await a.call(
        "/api/jobs",
        "POST",
        { ...input, prompt: "Different" },
        { "Idempotency-Key": idempotency },
      )
    ).statusCode,
    409,
  );
  assert.equal((await b.call("/api/jobs/" + id)).statusCode, 404);
  assert.equal(
    (
      await b.call("/api/jobs", "POST", input, {
        "Idempotency-Key": randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    await settleJob(db, id, "failed", null, "Provider failed"),
    true,
  );
  assert.equal(
    await settleJob(db, id, "failed", null, "Duplicate failure"),
    false,
  );
  assert.equal((await a.call("/api/me")).json().user.coins, 100);
});
test("successful jobs award configured completion rewards once; queue cancellation refunds", async (t) => {
  const { guest, db } = await fixture(t, {
    gateway: {
      run: async () => ({
        status: "succeeded",
        resultUrl: "https://cdn.example.com/result.png",
      }),
    },
  });
  const g = await guest();
  await transaction(
    db,
    async () => await credit(db, g.user.id, 87, "Test funds", "test"),
  );
  const result = await g.call(
    "/api/jobs",
    "POST",
    { mode: "image", prompt: "A landscape" },
    { "Idempotency-Key": randomUUID() },
  );
  const id = result.json().id;
  await settleJob(db, id, "succeeded", "https://cdn.example.com/result.png");
  await settleJob(db, id, "succeeded", "https://cdn.example.com/result.png");
  assert.equal((await g.call("/api/me")).json().user.coins, 64);
  const queued = (
    await g.call(
      "/api/jobs",
      "POST",
      { mode: "image", prompt: "Another landscape" },
      { "Idempotency-Key": randomUUID() },
    )
  ).json();
  assert.equal(
    (await g.call("/api/jobs/" + queued.id + "/cancel", "POST", {})).statusCode,
    200,
  );
  assert.equal((await g.call("/api/me")).json().user.coins, 64);
  assert.equal(
    (await g.call("/api/jobs/" + queued.id + "/cancel", "POST", {})).statusCode,
    409,
  );
});
test("admin adjustments are idempotent, auditable, and cannot overdraw; suspension invalidates sessions", async (t) => {
  const { admin, guest, db } = await fixture(t),
    g = await guest(),
    body = { amount: 25, reason: "Support credit", requestId: randomUUID() };
  const a = await admin("/users/" + g.user.id + "/coins", "POST", body);
  assert.equal(a.statusCode, 200, a.body);
  await admin("/users/" + g.user.id + "/coins", "POST", body);
  assert.equal((await g.call("/api/me")).json().user.coins, 38);
  assert.equal(
    (
      await admin("/users/" + g.user.id + "/coins", "POST", {
        ...body,
        amount: 26,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await admin("/users/" + g.user.id + "/coins", "POST", {
        ...body,
        amount: -100,
        requestId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM audit WHERE action='wallet.adjust'")
        .get()
    ).n,
    1,
  );
  await admin("/users/" + g.user.id, "PATCH", { status: "suspended" });
  assert.equal((await g.call("/api/me")).statusCode, 401);
});
test("account registration retains balance, login works, and deletion requires reauthentication", async (t) => {
  const { app, guest, db } = await fixture(t),
    g = await guest(),
    credentials = {
      email: "person@example.com",
      password: "strong-password-123",
    };
  const registered = await g.call("/api/auth/register", "POST", credentials);
  assert.equal(registered.statusCode, 200, registered.body);
  const signed = await app.inject({
    url: "/api/auth/login",
    method: "POST",
    payload: credentials,
  });
  assert.equal(signed.statusCode, 200, signed.body);
  assert.equal(signed.json().user.id, g.user.id);
  assert.equal(signed.json().user.coins, 13);
  assert.equal(
    (
      await g.call("/api/me", "DELETE", {
        confirmation: "DELETE",
        password: "wrong",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await g.call("/api/me", "DELETE", {
        confirmation: "DELETE",
        password: credentials.password,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    await db.prepare("SELECT * FROM users WHERE id=?").get(g.user.id),
    undefined,
  );
});
test("multipart uploads are private, reject arbitrary file content, and reports persist", async (t) => {
  const { app, guest, admin } = await fixture(t),
    a = await guest(),
    b = await guest();
  const boundary = "test-boundary";
  function body(bytes) {
    return Buffer.concat([
      Buffer.from(
        "--" +
          boundary +
          '\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      bytes,
      Buffer.from("\r\n--" + boundary + "--\r\n"),
    ]);
  }
  const bad = await a.call(
    "/api/uploads",
    "POST",
    body(Buffer.from("<script>alert(1)</script>")),
    { "content-type": "multipart/form-data; boundary=" + boundary },
  );
  assert.equal(bad.statusCode, 400, bad.body);
  const good = await a.call(
    "/api/uploads",
    "POST",
    body(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])),
    { "content-type": "multipart/form-data; boundary=" + boundary },
  );
  assert.equal(good.statusCode, 200, good.body);
  const id = good.json().id;
  assert.equal((await b.call("/api/uploads/" + id)).statusCode, 404);
  assert.equal((await app.inject("/media/" + id + ".png")).statusCode, 404);
  const report = await a.call("/api/reports", "POST", {
    reason: "Not the desired effect",
    templateId: "p0",
  });
  assert.equal(report.statusCode, 201);
  assert.equal((await admin("/reports")).json().reports.length, 1);
  await admin("/reports/" + report.json().id, "PATCH", { status: "resolved" });
  assert.equal((await admin("/reports")).json().reports[0].status, "resolved");
});
test("gateway URL policy rejects local destinations and non-HTTPS results", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.2",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  assert.throws(() =>
    validateGatewayUrl("https://evil.example.com", "gateway.example.com"),
  );
  assert.throws(() =>
    validateGatewayUrl("http://gateway.example.com", "gateway.example.com"),
  );
  assert.throws(() =>
    validateGatewayUrl(
      "https://user:password@gateway.example.com",
      "gateway.example.com",
    ),
  );
  assert.equal(safeResultUrl("javascript:alert(1)"), false);
  assert.equal(safeResultUrl("http://127.0.0.1/test.png"), false);
  assert.equal(safeResultUrl("https://cdn.example.com/image.png"), true);
});
test("worker polls provider jobs, resumes stored state, and credits completion once", async (t) => {
  let calls = 0;
  const gateway = {
    run: async (job) => {
      calls++;
      return job.provider_id
        ? {
            status: "succeeded",
            resultUrl: "https://cdn.example.com/final.png",
          }
        : { status: "processing", id: "provider-job-1" };
    },
  };
  const { guest, db, app } = await fixture(t, { gateway }),
    g = await guest();
  await transaction(
    db,
    async () => await credit(db, g.user.id, 87, "Test funds", "test"),
  );
  const job = (
    await g.call(
      "/api/jobs",
      "POST",
      { mode: "image", prompt: "A forest" },
      { "Idempotency-Key": randomUUID() },
    )
  ).json();
  await app.worker.tick();
  assert.equal(
    (await db.prepare("SELECT provider_id FROM jobs WHERE id=?").get(job.id))
      .provider_id,
    "provider-job-1",
  );
  await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(job.id);
  await app.worker.tick();
  assert.equal(
    (await g.call("/api/jobs/" + job.id)).json().status,
    "succeeded",
  );
  assert.equal((await g.call("/api/me")).json().user.coins, 64);
  await app.worker.tick();
  assert.equal(calls, 2);
});
test("worker retries gateway failures with the same job id and eventually refunds", async (t) => {
  const ids = [];
  const { guest, db, app } = await fixture(t, {
      gateway: {
        run: async (job) => {
          ids.push(job.id);
          throw new Error("Provider offline");
        },
      },
    }),
    g = await guest();
  await transaction(
    db,
    async () => await credit(db, g.user.id, 87, "Test funds", "test"),
  );
  const job = (
    await g.call(
      "/api/jobs",
      "POST",
      { mode: "image", prompt: "A forest" },
      { "Idempotency-Key": randomUUID() },
    )
  ).json();
  for (let i = 0; i < 5; i++) {
    await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(job.id);
    await app.worker.tick();
  }
  assert.equal(new Set(ids).size, 1);
  assert.equal(ids.length, 5);
  assert.equal((await g.call("/api/jobs/" + job.id)).json().status, "failed");
  assert.equal((await g.call("/api/me")).json().user.coins, 100);
});
test("database survives close/reopen with content and ledger intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-studio-persistence-")),
    file = join(dir, "db.sqlite");
  try {
    let db = await openDatabase(file);
    await db
      .prepare("INSERT INTO users(id,created_at) VALUES(?,?)")
      .run("persist-user", now());
    await transaction(
      db,
      async () =>
        await credit(db, "persist-user", 42, "Persistent credit", "test"),
    );
    const config = await getSetting(db, "published");
    config.content.home.title = "Persisted headline";
    await setSetting(db, "published", config);
    await db.close();
    db = await openDatabase(file);
    assert.equal(
      (
        await db
          .prepare("SELECT coins FROM users WHERE id='persist-user'")
          .get()
      ).coins,
      42,
    );
    assert.equal(
      (await getSetting(db, "published")).content.home.title,
      "Persisted headline",
    );
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM ledger").get()).n,
      1,
    );
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// R2 tests use an in-memory S3 transport and never load backend/.env.
import { fakeR2, multipart, png } from "./helpers/r2.mjs";
import { cleanupMedia } from "../server/cleanup-media.mjs";
import { readdirSync } from "node:fs";
test("R2 uploads enforce ownership, public visibility, storage failure handling and deletion", async (t) => {
  const mock = fakeR2();
  const { app, db, guest, headers, dir } = await fixture(t, {
    storage: mock.storage,
  });
  const owner = await guest(),
    other = await guest(),
    form = multipart();
  const response = await owner.call(
    "/api/uploads",
    "POST",
    form.body,
    form.headers,
  );
  assert.equal(response.statusCode, 200, response.body);
  const upload = response.json();
  const row = await db
    .prepare("SELECT * FROM uploads WHERE id=?")
    .get(upload.id);
  assert.ok(
    JSON.parse(row.storage).key.startsWith("uploads/images/" + owner.user.id),
  );
  assert.deepEqual(readdirSync(join(dir, "uploads")), []);
  assert.deepEqual((await owner.call(upload.url)).rawPayload, png);
  assert.equal((await other.call(upload.url)).statusCode, 404);
  assert.equal((await app.inject(upload.url)).statusCode, 401);
  assert.equal((await app.inject("/media/" + row.filename)).statusCode, 404);
  assert.deepEqual(await mock.storage(dir).readBuffer(row), png);
  const artwork = await app.inject({
    method: "POST",
    url: "/api/admin/media",
    headers: { ...headers, ...form.headers },
    payload: form.body,
  });
  assert.equal(artwork.statusCode, 200, artwork.body);
  assert.deepEqual((await app.inject(artwork.json().url)).rawPayload, png);
  mock.state.failDelete = true;
  const failed = await owner.call(upload.url, "DELETE");
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes("test-secret"));
  assert.ok(
    await db.prepare("SELECT id FROM uploads WHERE id=?").get(upload.id),
  );
  mock.state.failDelete = false;
  assert.equal((await owner.call(upload.url, "DELETE")).statusCode, 200);
  assert.equal((await owner.call(upload.url)).statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/admin/media/" + artwork.json().id,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(mock.files.size, 0);
  mock.state.failPut = true;
  const failedPut = await owner.call(
    "/api/uploads",
    "POST",
    form.body,
    form.headers,
  );
  assert.equal(failedPut.statusCode, 503);
  assert.ok(!failedPut.body.includes("test-secret"));
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM uploads").get()).n,
    0,
  );
});
test("R2 saves image/video outputs before success, retries storage without regenerating, and signs owner results", async (t) => {
  const mock = fakeR2();
  let providerCalls = 0;
  const { app, db, guest } = await fixture(t, {
    storage: mock.storage,
    gateway: {
      run: async () => {
        providerCalls++;
        return {
          status: "succeeded",
          resultUrl: "https://provider.example/result",
        };
      },
    },
  });
  const owner = await guest(),
    other = await guest();
  await transaction(
    db,
    async () => await credit(db, owner.user.id, 500, "Test funds", "r2-test"),
  );
  for (const mode of ["image", "video"]) {
    const key = randomUUID(),
      body = { mode, prompt: "A landscape" };
    const accepted = await owner.call("/api/jobs", "POST", body, {
      "Idempotency-Key": key,
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const id = accepted.json().id;
    mock.state.failPut = true;
    await app.worker.tick();
    assert.equal(
      (await db.prepare("SELECT status FROM jobs WHERE id=?").get(id)).status,
      "processing",
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS n FROM ledger WHERE reference=?")
          .get("reward:" + id)
      ).n,
      0,
    );
    const callsBeforeRetry = providerCalls;
    mock.state.failPut = false;
    await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(id);
    await app.worker.tick();
    assert.equal(providerCalls, callsBeforeRetry);
    const row = await db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.result_url, null);
    assert.ok(mock.files.has(JSON.parse(row.result_media).key));
    const result = (await owner.call("/api/jobs/" + id)).json();
    assert.ok(
      result.resultUrl.startsWith("https://private.example/generated/"),
    );
    assert.equal(
      result.resultMime,
      mode === "image" ? "image/png" : "video/mp4",
    );
    assert.equal((await other.call("/api/jobs/" + id)).statusCode, 404);
    assert.equal(
      (
        await owner.call("/api/jobs", "POST", body, { "Idempotency-Key": key })
      ).json().resultUrl,
      result.resultUrl,
    );
    assert.equal(
      (await db.prepare("SELECT count(*) AS n FROM pending_media").get()).n,
      0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS n FROM ledger WHERE reference=?")
          .get("reward:" + id)
      ).n,
      1,
    );
  }
  mock.state.failDelete = true;
  assert.equal(
    (await owner.call("/api/me", "DELETE", { confirmation: "DELETE" }))
      .statusCode,
    503,
  );
  assert.equal((await owner.call("/api/me")).statusCode, 200);
  mock.state.failDelete = false;
  assert.equal(
    (await owner.call("/api/me", "DELETE", { confirmation: "DELETE" }))
      .statusCode,
    200,
  );
  assert.equal(mock.files.size, 0);
});
test("R2 persistent storage failure refunds once and never repeats the AI generation", async (t) => {
  const mock = fakeR2();
  let calls = 0;
  const { app, db, guest } = await fixture(t, {
    storage: mock.storage,
    gateway: {
      run: async () => {
        calls++;
        return {
          status: "succeeded",
          resultUrl: "https://provider.example/result.png",
        };
      },
    },
  });
  const g = await guest();
  await transaction(
    db,
    async () => await credit(db, g.user.id, 87, "Test funds", "r2-refund"),
  );
  const response = await g.call(
    "/api/jobs",
    "POST",
    { mode: "image", prompt: "A tree" },
    { "Idempotency-Key": randomUUID() },
  );
  const id = response.json().id;
  mock.state.failPut = true;
  for (let n = 0; n < 5; n++) {
    await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(id);
    await app.worker.tick();
  }
  assert.equal(calls, 1);
  assert.equal((await g.call("/api/jobs/" + id)).json().status, "failed");
  assert.equal((await g.call("/api/me")).json().user.coins, 100);
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) AS n FROM ledger WHERE reference=?")
        .get("refund:" + id)
    ).n,
    1,
  );
});
test("cleanup deletes expired R2 inputs but retains images used by unfinished jobs", async (t) => {
  const mock = fakeR2();
  const { app, db, guest, storage } = await fixture(t, {
    storage: mock.storage,
    gateway: { run: async () => ({ status: "processing", id: "provider-1" }) },
  });
  const g = await guest(),
    form = multipart();
  await transaction(
    db,
    async () => await credit(db, g.user.id, 87, "Test funds", "cleanup"),
  );
  const first = (
    await g.call("/api/uploads", "POST", form.body, form.headers)
  ).json();
  const second = (
    await g.call("/api/uploads", "POST", form.body, form.headers)
  ).json();
  const job = await g.call(
    "/api/jobs",
    "POST",
    { mode: "image", prompt: "A flower", uploadIds: [first.id] },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(job.statusCode, 202, job.body);
  await db
    .prepare("UPDATE uploads SET created_at='2020-01-01T00:00:00.000Z'")
    .run();
  assert.equal(await cleanupMedia(db, storage), 1);
  assert.equal((await g.call(first.url)).statusCode, 200);
  assert.equal((await g.call(second.url)).statusCode, 404);
  await g.call("/api/jobs/" + job.json().id + "/cancel", "POST", {});
  assert.equal(await cleanupMedia(db, storage), 1);
  assert.equal(mock.files.size, 0);
});

test("overlapping worker ticks dispatch one provider request", async (t) => {
  let calls = 0;
  const { app, db, guest } = await fixture(t, {
    gateway: {
      run: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          status: "succeeded",
          resultUrl: "https://provider.example/once.png",
        };
      },
    },
  });
  const g = await guest();
  await transaction(db, async () => {
    await credit(db, g.user.id, 87, "Test", "worker-overlap");
  });
  const job = await g.call(
    "/api/jobs",
    "POST",
    { mode: "image", prompt: "A tree" },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(job.statusCode, 202);
  await Promise.all(Array.from({ length: 8 }, () => app.worker.tick()));
  assert.equal(calls, 1);
  assert.equal((await g.call("/api/me")).json().user.coins, 64);
});

test("a photo upload finishing after account deletion is removed from R2", async (t) => {
  const mock = fakeR2();
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { app, guest } = await fixture(t, {
    storage: (dir) => {
      const storage = mock.storage(dir),
        put = storage.putUpload.bind(storage);
      storage.putUpload = async (...args) => {
        const media = await put(...args);
        started();
        await gate;
        return media;
      };
      return storage;
    },
  });
  const g = await guest(),
    form = multipart();
  const upload = g.call("/api/uploads", "POST", form.body, form.headers);
  await entered;
  assert.equal(
    (await g.call("/api/me", "DELETE", { confirmation: "DELETE" })).statusCode,
    200,
  );
  release();
  assert.equal((await upload).statusCode, 403);
  assert.equal(mock.files.size, 0);
});

test("fal integration sends private R2 URLs, persists queue IDs, stores outputs and preserves ownership", async (t) => {
  const { falSettings, falModels } = await import("../server/fal.mjs");
  const mock = fakeR2();
  const calls = [];
  let providerModel,
    postCount = 0;
  const request = async (url, key, options = {}) => {
    assert.equal(key, "fal-test-key");
    calls.push({ url, ...options });
    if (options.method === "POST") {
      postCount++;
      providerModel = url.slice("https://queue.fal.run/".length);
      const root = providerModel.split("/").slice(0, 2).join("/");
      return {
        request_id: "request-" + postCount,
        status_url: `https://queue.fal.run/${root}/requests/request-${postCount}/status`,
        response_url: `https://queue.fal.run/${root}/requests/request-${postCount}`,
      };
    }
    if (url.endsWith("/status")) return { status: "COMPLETED" };
    return providerModel.includes("longcat")
      ? { video: { url: "https://fal.media/video.mp4" } }
      : { images: [{ url: "https://fal.media/image.png" }] };
  };
  const { app, db, guest, admin } = await fixture(t, {
    storage: mock.storage,
    falKey: "fal-test-key",
    falRequest: request,
  });
  await setSetting(db, "integration", falSettings);
  const config = await app.inject("/api/config");
  assert.deepEqual(config.json().services, {
    image: true,
    video: true,
    dance: true,
    slideshow: false,
    billing: false,
    ads: true,
  });
  assert.ok(!config.body.includes("fal-test-key"));
  const settings = await admin("/integration");
  assert.equal(settings.json().hasKey, true);
  assert.ok(!settings.body.includes("fal-test-key"));
  const owner = await guest(),
    other = await guest();
  await transaction(db, () =>
    credit(db, owner.user.id, 1000, "Test funds", "fal-test"),
  );
  const form = multipart();
  const uploaded = (
    await owner.call("/api/uploads", "POST", form.body, form.headers)
  ).json();
  for (const [mode, uploadIds, expected] of [
    ["image", [], falModels.image],
    ["image", [uploaded.id], falModels.edit],
    ["video", [uploaded.id], falModels.video],
    ["video", [], falModels.textVideo],
    ["dance", [uploaded.id], falModels.video],
  ]) {
    const key = randomUUID();
    const body = { mode, prompt: "Gentle natural movement", uploadIds };
    const response = await owner.call("/api/jobs", "POST", body, {
      "Idempotency-Key": key,
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().id;
    await app.worker.tick();
    const sent = calls.filter((c) => c.method === "POST").at(-1);
    assert.equal(sent.url, "https://queue.fal.run/" + expected);
    assert.ok(!JSON.stringify(sent.body).includes("base64"));
    if (uploadIds.length)
      assert.match(
        sent.body.image_url || sent.body.image_urls[0],
        /private.example.*expires=14400/,
      );
    assert.equal(
      (
        await db
          .prepare("SELECT request_id FROM fal_requests WHERE job_id=?")
          .get(id)
      ).request_id,
      "request-" + postCount,
    );
    await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(id);
    // A failed output copy must resume without submitting/polling the provider again.
    mock.state.failPut = true;
    await app.worker.tick();
    const previousCalls = calls.length;
    mock.state.failPut = false;
    await db.prepare("UPDATE jobs SET next_run=0 WHERE id=?").run(id);
    await app.worker.tick();
    assert.equal(calls.length, previousCalls);
    const finished = (await owner.call("/api/jobs/" + id)).json();
    assert.equal(finished.status, "succeeded");
    assert.match(finished.resultUrl, /private.example.*generated/);
    assert.equal((await other.call("/api/jobs/" + id)).statusCode, 404);
    assert.equal(
      (
        await owner.call("/api/jobs", "POST", body, { "Idempotency-Key": key })
      ).json().id,
      id,
    );
  }
  assert.equal(postCount, 5);
  const denied = await other.call(
    "/api/jobs",
    "POST",
    { mode: "image", prompt: "Edit", uploadIds: [uploaded.id] },
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(denied.statusCode, 404);
});

test("fal ambiguous submissions and interrupted submissions cannot create a second paid request", async (t) => {
  const { falSettings } = await import("../server/fal.mjs");
  const mock = fakeR2();
  let submits = 0;
  const { app, db, guest } = await fixture(t, {
    storage: mock.storage,
    falKey: "fal-test-key",
    falRequest: async () => {
      submits++;
      throw new Error("network with secret");
    },
  });
  await setSetting(db, "integration", falSettings);
  const owner = await guest();
  await transaction(db, () =>
    credit(db, owner.user.id, 500, "Test funds", "fal-test"),
  );
  for (const interrupted of [false, true]) {
    const response = await owner.call(
      "/api/jobs",
      "POST",
      { mode: "image", prompt: "Landscape" },
      { "Idempotency-Key": randomUUID() },
    );
    const id = response.json().id;
    if (interrupted)
      await db
        .prepare("INSERT INTO fal_requests(job_id,model) VALUES(?,?)")
        .run(id, falSettings.models.image);
    await app.worker.tick();
    await app.worker.tick();
    const result = (await owner.call("/api/jobs/" + id)).json();
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("secret"));
    assert.equal(
      (
        await db
          .prepare("SELECT count(*) AS n FROM ledger WHERE reference=?")
          .get("refund:" + id)
      ).n,
      1,
    );
  }
  assert.equal(submits, 1);
});

test("fal rejects unavailable configuration and limits active generations without charging rejected jobs", async (t) => {
  const { falSettings } = await import("../server/fal.mjs");
  const mock = fakeR2();
  const { app, db, guest, admin } = await fixture(t, {
    storage: mock.storage,
    falKey: "fal-test-key",
  });
  await setSetting(db, "integration", falSettings);
  const owner = await guest();
  await transaction(db, () =>
    credit(db, owner.user.id, 500, "Test funds", "fal-test"),
  );
  const submit = () =>
    owner.call(
      "/api/jobs",
      "POST",
      { mode: "image", prompt: "Landscape" },
      { "Idempotency-Key": randomUUID() },
    );
  assert.equal((await submit()).statusCode, 202);
  assert.equal((await submit()).statusCode, 202);
  const coins = (
    await db.prepare("SELECT coins FROM users WHERE id=?").get(owner.user.id)
  ).coins;
  assert.equal((await submit()).statusCode, 429);
  assert.equal(
    (await db.prepare("SELECT coins FROM users WHERE id=?").get(owner.user.id))
      .coins,
    coins,
  );
  assert.equal(
    (
      await admin("/integration", "PUT", {
        settings: falSettings,
        apiKey: "should-not-be-saved",
      })
    ).statusCode,
    400,
  );
});
