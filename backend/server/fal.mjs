import { safeResultUrl } from "./gateway.mjs";
import {
  compileEditPrompt,
  compileGenerationPrompt,
} from "./image-prompts.mjs";

export const falModels = Object.freeze({
  image: "fal-ai/flux-2-pro",
  edit: "fal-ai/flux-pro/kontext",
  video: "fal-ai/longcat-video/distilled/image-to-video/720p",
  textVideo: "fal-ai/longcat-video/distilled/text-to-video/720p",
});
export const falImageCatalog = Object.freeze({
  image: [
    {
      id: "fal-ai/flux/schnell",
      label: "FLUX.1 Schnell",
      tier: "Economy",
      price: "$0.003 per output megapixel",
      estimate: "$0.003 per billed MP",
      description: "Text-to-image only in this app; never used when a photo is uploaded. Fastest and cheapest for previews and high-volume drafts.",
      docs: "https://fal.ai/models/fal-ai/flux/schnell",
    },
    {
      id: "fal-ai/flux-2/klein/9b/base",
      label: "FLUX.2 Klein 9B",
      tier: "Balanced",
      price: "$0.011 per output megapixel",
      estimate: "About $0.011 at 1 MP",
      description: "Better realism and prompt fidelity with configurable inference quality.",
      docs: "https://fal.ai/models/fal-ai/flux-2/klein/9b/base",
    },
    {
      id: "fal-ai/flux-2-pro",
      label: "FLUX.2 Pro",
      tier: "Recommended",
      price: "$0.03 for the first output MP, then $0.015 per additional MP",
      estimate: "$0.03 at 1 MP",
      description: "Production-oriented quality and consistency without manual step tuning.",
      docs: "https://fal.ai/models/fal-ai/flux-2-pro",
    },
  ],
  edit: [
    {
      id: "fal-ai/flux-2/klein/9b/base/edit",
      label: "FLUX.2 Klein 9B Edit",
      tier: "Balanced",
      price: "$0.011 per input MP and output MP",
      estimate: "About $0.022 for 1 MP input + 1 MP output",
      description: "Used for uploaded-photo generations when selected. Cost-controlled editing; roughly $0.022 for a 1 MP input and 1 MP output.",
      docs: "https://fal.ai/models/fal-ai/flux-2/klein/9b/base/edit",
    },
    {
      id: "fal-ai/flux-pro/kontext",
      label: "FLUX.1 Kontext Pro",
      tier: "Recommended",
      price: "$0.04 per image",
      estimate: "$0.04 per edit",
      description: "Used for uploaded-photo generations when selected. Strong local edits and character consistency for production use.",
      docs: "https://fal.ai/models/fal-ai/flux-pro/kontext",
    },
    {
      id: "fal-ai/flux-pro/kontext/max",
      label: "FLUX.1 Kontext Max",
      tier: "Maximum",
      price: "$0.08 per image",
      estimate: "$0.08 per edit",
      description: "Used for uploaded-photo generations when selected. Highest prompt adherence and consistency for demanding edits.",
      docs: "https://fal.ai/models/fal-ai/flux-pro/kontext/max",
    },
  ],
  pricingChecked: "2026-09-23",
});
const imageEndpoints = new Set(falImageCatalog.image.map((m) => m.id));
const editEndpoints = new Set(falImageCatalog.edit.map((m) => m.id));
export const isFalImageModel = (kind, id) =>
  (kind === "image" ? imageEndpoints : editEndpoints).has(id);
export const falImageSizes = Object.freeze([
  { id: "square_hd", label: "Square · 1:1" },
  { id: "portrait_4_3", label: "Portrait · 3:4" },
  { id: "portrait_16_9", label: "Portrait · 9:16" },
  { id: "landscape_4_3", label: "Landscape · 4:3" },
  { id: "landscape_16_9", label: "Landscape · 16:9" },
]);
export const falSettings = {
  provider: "fal",
  enabled: true,
  gatewayUrl: "https://queue.fal.run",
  imageSize: "square_hd",
  models: {
    image: falModels.image,
    edit: falModels.edit,
    video: falModels.video,
    dance: falModels.video,
    slideshow: "",
  },
};

export function normalizeFalSettings(settings = {}) {
  const models = settings.models || {};
  return {
    ...falSettings,
    enabled: !!settings.enabled,
    imageSize: falImageSizes.some((size) => size.id === settings.imageSize)
      ? settings.imageSize
      : falSettings.imageSize,
    models: {
      ...falSettings.models,
      image: imageEndpoints.has(models.image) ? models.image : falModels.image,
      edit: editEndpoints.has(models.edit) ? models.edit : falModels.edit,
    },
  };
}

export function nearestAspectRatio(width, height) {
  if (!(width > 0 && height > 0)) return undefined;
  const ratio = width / height;
  return [
    ["21:9", 21 / 9],
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["1:1", 1],
    ["2:3", 2 / 3],
    ["3:4", 3 / 4],
    ["9:16", 9 / 16],
    ["9:21", 9 / 21],
  ].reduce((best, candidate) =>
    Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio)
      ? candidate
      : best,
  )[0];
}

export function falInput(input, urls = [], settings = falSettings, uploads = []) {
  if (!["image", "video", "dance"].includes(input.mode))
    throw new Error("This tool is not supported by the fal integration.");
  if (urls.length > 1 || (input.mode === "dance" && urls.length !== 1))
    throw new Error("This tool requires a single input photo.");
  const normalized = normalizeFalSettings({ ...settings, enabled: true });
  if (input.mode === "image") {
    const prompt = urls.length
      ? compileEditPrompt(input.prompt, { background: input.background })
      : compileGenerationPrompt(input.prompt);
    const model = urls.length
      ? normalized.models.edit
      : normalized.models.image;
    if (urls.length && model.startsWith("fal-ai/flux-pro/kontext")) {
      const aspectRatio = nearestAspectRatio(uploads[0]?.width, uploads[0]?.height);
      return {
        model,
        input: {
          prompt,
          image_url: urls[0],
          guidance_scale: 3.5,
          num_images: 1,
          output_format: "png",
          safety_tolerance: "2",
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        },
      };
    }
    if (urls.length) {
      return {
        model,
        input: {
          prompt,
          image_urls: urls,
          negative_prompt:
            "identity drift, changed face, altered pose, changed crop, unrelated objects, duplicate people, malformed hands, watermark, caption, blurry detail",
          num_images: 1,
          num_inference_steps: 32,
          guidance_scale: 4.5,
          acceleration: "regular",
          enable_safety_checker: true,
          output_format: "png",
        },
      };
    }
    if (model === "fal-ai/flux-2-pro") {
      return {
        model,
        input: {
          prompt,
          image_size: normalized.imageSize,
          enable_safety_checker: true,
          safety_tolerance: "2",
          output_format: "png",
        },
      };
    }
    return {
      model,
      input: {
        prompt,
        image_size: normalized.imageSize,
        num_images: 1,
        num_inference_steps:
          model === "fal-ai/flux/schnell" ? 4 : 32,
        guidance_scale:
          model === "fal-ai/flux/schnell" ? 3.5 : 4,
        enable_safety_checker: true,
        output_format: "png",
      },
    };
  }
  let prompt = input.prompt;
  if (urls.length) {
    prompt +=
      ". Preserve the exact identity, face, body proportions, clothing, and framing of the input person.";
    if (input.background)
      prompt += ` Replace only the background with: ${input.background}.`;
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
    async run(job, config = falSettings) {
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
        const urls = [], uploads = [];
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
          uploads.push(upload);
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
        const payload = falInput(input, urls, config, uploads);
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
