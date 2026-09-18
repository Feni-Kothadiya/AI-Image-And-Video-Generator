import { safeResultUrl } from "./gateway.mjs";

export const falModels = Object.freeze({
  image: "fal-ai/flux/schnell",
  edit: "fal-ai/flux-2/klein/4b/base/edit",
  video: "fal-ai/longcat-video/distilled/image-to-video/720p",
  textVideo: "fal-ai/longcat-video/distilled/text-to-video/720p",
});
export const falSettings = {
  provider: "fal",
  enabled: true,
  gatewayUrl: "https://queue.fal.run",
  models: {
    image: falModels.image,
    video: falModels.video,
    dance: falModels.video,
    slideshow: "",
  },
};

export function falInput(input, urls = []) {
  if (!["image", "video", "dance"].includes(input.mode))
    throw new Error("This tool is not supported by the fal integration.");
  if (urls.length > 1 || (input.mode === "dance" && urls.length !== 1))
    throw new Error("This tool requires a single input photo.");
  let prompt = input.prompt;
  if (urls.length) {
    prompt += "\nPreserve the subject's identity and facial features.";
    if (input.background === "Original")
      prompt += " Keep the original background.";
    else prompt += " Adapt the background to the requested scene.";
  }
  if (input.mode === "image") {
    return {
      model: urls.length ? falModels.edit : falModels.image,
      input: {
        prompt,
        // Under one decimal megapixel, with dimensions divisible by 32.
        image_size: { width: 960, height: 960 },
        num_images: 1,
        num_inference_steps: urls.length ? 28 : 4,
        enable_safety_checker: true,
        output_format: "png",
        ...(urls.length ? { image_urls: urls, guidance_scale: 5 } : {}),
      },
    };
  }
  return {
    model: urls.length ? falModels.video : falModels.textVideo,
    input: {
      prompt,
      ...(urls.length ? { image_url: urls[0] } : { aspect_ratio: "9:16" }),
      num_frames: 162,
      fps: 30,
      num_inference_steps: 12,
      num_refine_inference_steps: 12,
      enable_prompt_expansion: false,
      enable_safety_checker: true,
      video_output_type: "X264 (.mp4)",
      video_quality: "high",
    },
  };
}

// Accept only queue URLs for this model and request; never forward the key elsewhere.
export function queueUrl(value, model, id, suffix) {
  const url = new URL(value);
  const root = model.split("/").slice(0, 2).join("/");
  const prefixes = [root, model];
  if (
    url.origin !== "https://queue.fal.run" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !prefixes.some(
      (prefix) => url.pathname === `/${prefix}/requests/${id}${suffix}`,
    )
  )
    throw new Error("Invalid fal queue URL.");
  return url.href;
}

export async function falRequest(
  url,
  key,
  { method = "GET", body, fetchImpl = fetch } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: "Key " + key,
        "Content-Type": "application/json",
        ...(method === "POST"
          ? { "X-Fal-Request-Timeout": "3600", "X-Fal-No-Retry": "1" }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("fal request failed."), {
        terminal: [400, 401, 403, 404, 422].includes(response.status),
      });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("Response too large.");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw Object.assign(new Error("fal request unavailable."), {
      terminal: !!error.terminal,
    });
  }
}

export function createFalGateway({
  db,
  storage,
  apiKey,
  request = falRequest,
}) {
  return {
    async run(job) {
      if (!apiKey || storage.mode !== "r2")
        throw new Error("fal requires an API key and R2.");
      let tracked = await db
        .prepare("SELECT * FROM fal_requests WHERE job_id=?")
        .get(job.id);
      if (tracked && !tracked.request_id) {
        return {
          status: "failed",
          message:
            "The submission could not be confirmed. It was not sent again to avoid duplicate charges. Your coins were refunded.",
        };
      }
      if (!tracked) {
        const input = JSON.parse(job.request);
        const urls = [];
        for (const id of input.uploadIds) {
          const upload = await db
            .prepare(
              "SELECT * FROM uploads WHERE id=? AND user_id=? AND public=0",
            )
            .get(id, job.user_id);
          if (!upload)
            throw Object.assign(new Error("Input photo is unavailable."), {
              terminal: true,
            });
          // Upgrade any pre-R2 input before giving fal its signed URL.
          if (!upload.storage) {
            const media = await storage.putUpload(
              upload.filename,
              await storage.readBuffer(upload),
              upload.mime,
              false,
              job.user_id,
            );
            upload.storage = JSON.stringify(media);
            await db
              .prepare("UPDATE uploads SET storage=? WHERE id=?")
              .run(upload.storage, upload.id);
          }
          urls.push(await storage.inputUrl(upload));
        }
        const payload = falInput(input, urls);
        // Durable marker BEFORE the POST: a crash or lost response must never resubmit.
        const claim = await db
          .prepare(
            "INSERT INTO fal_requests(job_id,model) VALUES(?,?) ON CONFLICT(job_id) DO NOTHING",
          )
          .run(job.id, payload.model);
        if (!claim.changes) throw new Error("Submission already claimed.");
        let submitted;
        try {
          submitted = await request(
            "https://queue.fal.run/" + payload.model,
            apiKey,
            { method: "POST", body: payload.input },
          );
          const id = submitted.request_id;
          if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id))
            throw new Error("Invalid request ID.");
          const statusUrl = queueUrl(
            submitted.status_url,
            payload.model,
            id,
            "/status",
          );
          // fal returns response_url without /response on current model endpoints.
          let responseUrl;
          try {
            responseUrl = queueUrl(
              submitted.response_url,
              payload.model,
              id,
              "",
            );
          } catch {
            responseUrl = queueUrl(
              submitted.response_url,
              payload.model,
              id,
              "/response",
            );
          }
          await db.transaction(async () => {
            await db
              .prepare(
                "UPDATE fal_requests SET request_id=?,status_url=?,response_url=? WHERE job_id=?",
              )
              .run(id, statusUrl, responseUrl, job.id);
            await db
              .prepare("UPDATE jobs SET provider_id=? WHERE id=?")
              .run(id, job.id);
          });
          return { status: "queued", id };
        } catch {
          // Leave the marker for reconciliation; do not retry a possibly accepted POST.
          return {
            status: "failed",
            message:
              "The generation submission could not be confirmed. It was not sent again. Your coins were refunded.",
          };
        }
      }
      const status = await request(
        queueUrl(
          tracked.status_url,
          tracked.model,
          tracked.request_id,
          "/status",
        ),
        apiKey,
      );
      if (["IN_QUEUE", "IN_PROGRESS"].includes(status.status))
        return { status: "processing", id: tracked.request_id };
      if (status.status !== "COMPLETED" || status.error || status.error_type)
        return { status: "failed" };
      let responseUrl;
      try {
        responseUrl = queueUrl(
          tracked.response_url,
          tracked.model,
          tracked.request_id,
          "",
        );
      } catch {
        responseUrl = queueUrl(
          tracked.response_url,
          tracked.model,
          tracked.request_id,
          "/response",
        );
      }
      const output = await request(responseUrl, apiKey);
      if (output.has_nsfw_concepts?.some(Boolean)) return { status: "failed" };
      const resultUrl =
        JSON.parse(job.request).mode === "image"
          ? output.images?.[0]?.url
          : output.video?.url;
      if (typeof resultUrl !== "string" || !safeResultUrl(resultUrl))
        return { status: "failed" };
      return { status: "succeeded", resultUrl };
    },
  };
}
