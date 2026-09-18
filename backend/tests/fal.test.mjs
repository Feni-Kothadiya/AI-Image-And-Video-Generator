import { test } from "node:test";
import assert from "node:assert/strict";
import { falInput, falModels, falRequest, queueUrl } from "../server/fal.mjs";

test("fal presets bound image size, output count and video duration", () => {
  const image = falInput({ mode: "image", prompt: "A landscape" });
  assert.equal(image.model, falModels.image);
  assert.equal(image.input.num_images, 1);
  assert.ok(image.input.image_size.width * image.input.image_size.height < 1e6);
  assert.equal(image.input.num_inference_steps, 4);
  const edit = falInput(
    { mode: "image", prompt: "A portrait", background: "Original" },
    ["https://r2.example/input"],
  );
  assert.equal(edit.model, falModels.edit);
  assert.equal(edit.input.num_inference_steps, 28);
  assert.match(edit.input.prompt, /original background/);
  const video = falInput({ mode: "video", prompt: "A landscape" });
  assert.equal(video.input.num_frames / video.input.fps, 5.4);
  assert.equal(video.input.video_output_type, "X264 (.mp4)");
  assert.equal(video.input.enable_prompt_expansion, false);
  assert.throws(() => falInput({ mode: "slideshow" }));
  assert.throws(() => falInput({ mode: "dance" }));
});

test("fal queue URLs cannot forward credentials to another origin or job", () => {
  const model = falModels.edit,
    id = "request-123";
  const valid = `https://queue.fal.run/fal-ai/flux-2/requests/${id}/status`;
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
