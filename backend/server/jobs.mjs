import { randomUUID } from "node:crypto";
import { transaction, credit, getSetting, now } from "./db.mjs";
import { hash } from "./security.mjs";
import { parse, jobSchema, fail } from "./schema.mjs";
import { safeResultUrl } from "./gateway.mjs";
import { premiumEntitlement, billingDebt } from "./billing.mjs";
export async function createJob(db, user, key, input, integrationReady) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    fail(400, "A unique Idempotency-Key header is required.");
  const request = parse(jobSchema, input),
    requestHash = hash(JSON.stringify(request));
  return await transaction(db, async () => {
    if (
      (await db.prepare("SELECT status FROM users WHERE id=?").get(user.id))
        ?.status !== "active"
    )
      fail(403, "Account is not available.");
    const existing = await db
      .prepare("SELECT * FROM jobs WHERE user_id=? AND idempotency_key=?")
      .get(user.id, key);
    if (existing) {
      if (existing.request_hash !== requestHash)
        fail(409, "This request key was already used for different inputs.");
      return publicJob(existing);
    }
    const config = (await getSetting(db, "published")).content;
    if (config.features.maintenance || !config.features[request.mode])
      fail(503, "This tool is temporarily unavailable.");
    const integration = await getSetting(db, "integration");
    if (!integrationReady(integration, request.mode))
      fail(503, "AI provider is not connected yet. No coins were deducted.");
    const template = request.templateId
      ? config.templates.find((t) => t.id === request.templateId && t.enabled)
      : null;
    if (request.templateId && (!template || template.kind !== request.mode))
      fail(400, "Template is no longer available for this tool.");
    const premium = await premiumEntitlement(db, user.id);
    if (template?.premium && !premium.active)
      fail(403, "A premium subscription is required for this template.");
    if (await billingDebt(db, user.id)) fail(409, "A refunded coin balance must be settled before generating. Contact support or top up coins.");
    if (request.mode !== "slideshow" && !request.prompt)
      fail(400, "Describe what you want to create.");
    if ((template || request.mode === "dance") && !request.uploadIds.length)
      fail(400, "Add a photo to continue.");
    if (
      request.mode === "slideshow" &&
      (!template || request.uploadIds.length !== template.count)
    )
      fail(400, "Choose the number of photos required by this template.");
    if (request.mode !== "slideshow" && request.uploadIds.length > 1)
      fail(400, "This tool accepts one input photo.");
    let total = 0;
    for (const id of request.uploadIds) {
      const upload = await db
        .prepare(
          "SELECT bytes FROM uploads WHERE id=? AND user_id=? AND public=0",
        )
        .get(id, user.id);
      if (!upload) fail(404, "Input photo not found.");
      total += upload.bytes;
    }
    if (total > 30 * 1024 * 1024)
      fail(400, "Input photos must total less than 30 MB.");
    if (
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE user_id=? AND status IN ('queued','processing')",
          )
          .get(user.id)
      ).n >= 3
    )
      fail(429, "Wait for an existing generation to finish.");
    const id = randomUUID(),
      time = now(),
      cost = request.mode === "slideshow" || premium.unlimitedGeneration
        ? 0
        : config.costs[request.mode];
    const reward =
      config.rewards[request.mode === "dance" ? "video" : request.mode];
    const payload = {
      ...request,
      ...(template ? { duration: template.duration } : {}),
    };
    await credit(db, user.id, -cost, "Generation reserved", "job:" + id);
    await db
      .prepare(
        "INSERT INTO jobs(id,user_id,idempotency_key,request,request_hash,status,cost,reward,provider_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        user.id,
        key,
        JSON.stringify(payload),
        requestHash,
        "queued",
        cost,
        reward,
        JSON.stringify(integration),
        time,
        time,
      );
    return publicJob(await db.prepare("SELECT * FROM jobs WHERE id=?").get(id));
  });
}
export function publicJob(job) {
  const input = JSON.parse(job.request);
  return {
    id: job.id,
    mode: input.mode,
    prompt: input.prompt,
    templateId: input.templateId,
    status: job.status,
    cost: job.cost,
    resultUrl: job.result_url,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
export async function settleJob(
  db,
  id,
  status,
  resultUrl = null,
  message = null,
  media = null,
) {
  return await transaction(db, async () => {
    const job = await db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!job || !["queued", "processing"].includes(job.status)) return false;
    if (status === "cancelled" && job.status !== "queued")
      fail(409, "Only jobs waiting to start can be cancelled.");
    if (status === "succeeded" && !media && !safeResultUrl(resultUrl))
      throw new Error("Invalid result URL.");
    if (status === "failed" || status === "cancelled")
      await credit(
        db,
        job.user_id,
        job.cost,
        "Generation refunded",
        "refund:" + id,
      );
    if (status === "succeeded" && job.reward)
      await credit(
        db,
        job.user_id,
        job.reward,
        "Creation reward",
        "reward:" + id,
      );
    await db
      .prepare(
        "UPDATE jobs SET status=?,result_url=?,result_media=?,error=?,updated_at=? WHERE id=?",
      )
      .run(
        status,
        media ? null : resultUrl,
        media ? JSON.stringify(media) : null,
        message,
        now(),
        id,
      );
    await db.prepare("DELETE FROM pending_media WHERE job_id=?").run(id);
    return true;
  });
}
export function createWorker({
  db,
  gateway,
  storage,
  logger,
  autoStart = true,
}) {
  let working = false,
    stopped = false;
  async function tick() {
    if (working || stopped) return;
    working = true;
    let job;
    try {
      job = await db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued','processing') AND next_run<=? ORDER BY created_at LIMIT 1",
        )
        .get(Date.now());
      if (!job) return;
      if (Date.now() - Date.parse(job.created_at) > 2 * 60 * 60 * 1000) {
        await settleJob(
          db,
          job.id,
          "failed",
          null,
          "Generation timed out. Your coins were refunded.",
        );
        return;
      }
      // Persist before dispatch. Gateway must honor clientJobId/Idempotency-Key on retry.
      const claimed = await db
        .prepare(
          "UPDATE jobs SET status='processing',next_run=?,updated_at=? WHERE id=? AND status IN ('queued','processing')",
        )
        .run(Date.now() + 10000, now(), job.id);
      if (!claimed.changes) return;
      const pending = await db
        .prepare("SELECT url FROM pending_media WHERE job_id=?")
        .get(job.id);
      const output = pending
        ? { status: "succeeded", resultUrl: pending.url }
        : await gateway.run(job, JSON.parse(job.provider_config));
      if (output.status === "succeeded") {
        if (storage?.mode === "r2") {
          if (!safeResultUrl(output.resultUrl))
            throw new Error("Invalid result URL.");
          // A storage retry must not submit another paid provider generation.
          await db
            .prepare(
              "INSERT INTO pending_media VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET url=excluded.url",
            )
            .run(job.id, output.resultUrl);
          const media = await storage.saveResult(job, output.resultUrl);
          await settleJob(db, job.id, "succeeded", null, null, media);
        } else await settleJob(db, job.id, "succeeded", output.resultUrl);
      } else if (output.status === "failed")
        await settleJob(
          db,
          job.id,
          "failed",
          null,
          output.message ||
          "The provider could not complete this request. Your coins were refunded.",
        );
      else
        await db
          .prepare(
            "UPDATE jobs SET provider_id=?,attempts=0,next_run=?,updated_at=? WHERE id=? AND status='processing'",
          )
          .run(output.id, Date.now() + 5000, now(), job.id);
    } catch (e) {
      logger?.warn(
        { jobId: job?.id },
        "Provider attempt failed; credentials and response bodies are not logged.",
      );
      if (!job) return;
      if (e.terminal || job.attempts >= 4)
        await settleJob(
          db,
          job.id,
          "failed",
          null,
          "The AI service could not be reached. Your coins were refunded.",
        );
      else
        await db
          .prepare("UPDATE jobs SET attempts=attempts+1,next_run=? WHERE id=?")
          .run(Date.now() + Math.min(60000, 5000 * 2 ** job.attempts), job.id);
    } finally {
      working = false;
    }
  }
  const timer = autoStart
    ? setInterval(() => {
      void tick().catch(() =>
        logger?.warn("Job worker will retry after a database failure."),
      );
    }, 1500)
    : null;
  timer?.unref();
  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (working) await new Promise((r) => setTimeout(r, 50));
    },
  };
}
