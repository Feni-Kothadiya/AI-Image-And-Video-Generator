import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { createStorage } from "../../server/storage.mjs";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
export const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(12),
]);
export const dummyEnv = {
  R2_ENDPOINT:
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_BUCKET: "test-media",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
};
export function fakeR2() {
  const files = new Map(),
    calls = [];
  const state = { failPut: false, failDelete: false, downloads: 0 };
  const client = {
    async send(command) {
      const name = command.constructor.name,
        input = command.input;
      calls.push({ name, key: input.Key, bucket: input.Bucket });
      if (name === "PutObjectCommand") {
        if (state.failPut) throw new Error("test-secret must not leak");
        const chunks = [];
        if (Buffer.isBuffer(input.Body)) chunks.push(input.Body);
        else
          for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
        files.set(input.Key, Buffer.concat(chunks));
        return {};
      }
      if (name === "GetObjectCommand") {
        if (!files.has(input.Key))
          throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: Readable.from([files.get(input.Key)]) };
      }
      if (name === "DeleteObjectCommand") {
        if (state.failDelete) throw new Error("test-secret must not leak");
        files.delete(input.Key);
        return {};
      }
      throw new Error("Unexpected SDK command");
    },
  };
  return {
    files,
    calls,
    state,
    client,
    storage: (dataDir) =>
      createStorage({
        dataDir,
        env: dummyEnv,
        client,
        signer: async (_client, command, options) =>
          `https://private.example/${command.input.Key}?expires=${options.expiresIn}`,
        downloader: async (_url, path, mode) => {
          state.downloads++;
          const buffer = mode === "image" ? png : mp4;
          await writeFile(path, buffer);
          return {
            mime: mode === "image" ? "image/png" : "video/mp4",
            ext: mode === "image" ? "png" : "mp4",
            bytes: buffer.length,
          };
        },
      }),
  };
}
export function multipart(bytes = png) {
  return {
    headers: { "content-type": "multipart/form-data; boundary=r2-test" },
    body: Buffer.concat([
      Buffer.from(
        '--r2-test\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
      bytes,
      Buffer.from("\r\n--r2-test--\r\n"),
    ]),
  };
}
