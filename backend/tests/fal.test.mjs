import { test } from "node:test";
import assert from "node:assert/strict";
import {
  falImageCatalog,
  falInput,
  falModels,
  falRequest,
  falSettings,
  nearestAspectRatio,
  queueUrl,
} from "../server/fal.mjs";

test("fal presets select production image quality and preserve edit shape", () => {
  const image = falInput({ mode: "image", prompt: "A landscape" });
  assert.equal(image.model, falModels.image);
  assert.equal(image.input.image_size, "square_hd");
  assert.equal(image.input.output_format, "png");
  assert.match(image.input.prompt, /PRIMARY CREATIVE BRIEF/);
  assert.match(image.input.prompt, /LIGHT AND MATERIALS/);
  const edit = falInput(
    { mode: "image", prompt: "A portrait", background: "Original" },
    ["https://r2.example/input"],
    falSettings,
    [{ width: 1200, height: 1600 }],
  );
  assert.equal(edit.model, falModels.edit);
  assert.equal(edit.input.aspect_ratio, "3:4");
  assert.equal(edit.input.image_url, "https://r2.example/input");
  assert.match(edit.input.prompt, /BACKGROUND LOCK/);
  assert.match(edit.input.prompt, /IDENTITY LOCK/);
  assert.match(edit.input.prompt, /Do not generate a new face/);
  assert.equal("enhance_prompt" in edit.input, false);
  const economy = falInput(
    { mode: "image", prompt: "A landscape" },
    [],
    { ...falSettings, models: { ...falSettings.models, image: "fal-ai/flux/schnell" } },
  );
  assert.equal(economy.input.num_inference_steps, 4);
  assert.equal(falImageCatalog.image[0].estimate, "$0.003 per billed MP");
  assert.equal(falImageCatalog.image[2].estimate, "$0.03 at 1 MP");
  assert.equal(nearestAspectRatio(1920, 1080), "16:9");
  const video = falInput({ mode: "video", prompt: "A landscape" });
  assert.equal(video.input.prompt, "A landscape");
  assert.equal(video.input.num_frames / video.input.fps, 5.4);
  assert.equal(video.input.video_output_type, "X264 (.mp4)");
  assert.equal(video.input.enable_prompt_expansion, false);
  assert.throws(() => falInput({ mode: "slideshow" }));
  assert.throws(() => falInput({ mode: "dance" }));
});

test("fal queue URLs cannot forward credentials to another origin or job", () => {
  const model = falModels.edit,
    id = "request-123";
  const valid = `https://queue.fal.run/fal-ai/flux-pro/requests/${id}/status`;
  assert.equal(queueUrl(valid, model, id, "/status"), valid);
  for (const bad of [
    valid.replace("queue.fal.run", "evil.example"),
    valid.replace("https:", "http:"),
    valid.replace(id, "other"),
    valid + "?secret=x",
    valid.replace("https://", "https://user:password@"),
  ])
    assert.throws(() => queueUrl(bad, model, id, "/status"));
});

test("fal transport uses key auth, disables POST retries and sanitizes provider errors", async () => {
  let calls = 0;
  await assert.rejects(
    falRequest("https://queue.fal.run/test", "private-key", {
      method: "POST",
      body: { prompt: "test" },
      fetchImpl: async (_url, options) => {
        calls++;
        assert.equal(options.headers.Authorization, "Key private-key");
        assert.equal(options.redirect, "error");
        assert.equal(options.headers["X-Fal-No-Retry"], "1");
        return new Response("private-key details", { status: 401 });
      },
    }),
    (error) => error.terminal && !error.message.includes("private-key"),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    falRequest("https://queue.fal.run/test", "private-key", {
      fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
    }),
    /unavailable/,
  );
});
