import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { writeFile, readFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { downloadMedia } from "./media-download.mjs";

function unavailable() {
  return Object.assign(
    new Error("Media storage is unavailable. Please try again."),
    { statusCode: 503 },
  );
}
export function storageConfig(env) {
  const mode = env.MEDIA_STORAGE || (env.R2_BUCKET ? "r2" : "local");
  if (!["local", "r2"].includes(mode))
    throw new Error("MEDIA_STORAGE must be local or r2.");
  if (mode === "local") return { mode };
  const endpoint =
    env.R2_ENDPOINT ||
    (env.R2_ACCOUNT_ID
      ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : "");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Set a valid R2_ENDPOINT.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    url.pathname !== "/" ||
    !/^[a-f0-9]{32}(\.(eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(
      url.hostname,
    )
  )
    throw new Error("R2_ENDPOINT must be the Cloudflare S3 account endpoint.");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET || ""))
    throw new Error("Set a valid R2_BUCKET.");
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw new Error("R2 access credentials are required.");
  return {
    mode,
    endpoint: url.href,
    bucket: env.R2_BUCKET,
    region: env.R2_REGION || "auto",
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  };
}

export function createStorage({
  dataDir,
  env = process.env,
  client,
  signer = getSignedUrl,
  downloader = downloadMedia,
} = {}) {
  const config = storageConfig(env);
  const s3 =
    config.mode === "r2"
      ? client ||
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          credentials: config.credentials,
          forcePathStyle: true,
          maxAttempts: 3,
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          requestHandler: { connectionTimeout: 10000, requestTimeout: 120000 },
        })
      : null;
  const localPath = (filename) => {
    if (
      !filename ||
      basename(filename) !== filename ||
      filename === "." ||
      filename === ".."
    )
      throw new Error("Invalid stored filename.");
    return join(dataDir, "uploads", filename);
  };
  async function send(command) {
    if (!s3) throw unavailable();
    try {
      return await s3.send(command);
    } catch (error) {
      if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404)
        throw Object.assign(new Error("Media file not found."), {
          statusCode: 404,
        });
      throw unavailable();
    }
  }
  function objectInput(media) {
    return { Bucket: media.bucket, Key: media.key };
  }
  return {
    mode: config.mode,
    async putUpload(filename, buffer, mime, isPublic, userId) {
      if (!s3) {
        await writeFile(localPath(filename), buffer, {
          flag: "wx",
          mode: 0o600,
        });
        return null;
      }
      const media = {
        bucket: config.bucket,
        key: `${isPublic ? "templates" : "uploads/images/" + userId}/${filename}`,
        mime,
        bytes: buffer.length,
      };
      await send(
        new PutObjectCommand({
          ...objectInput(media),
          Body: buffer,
          ContentType: mime,
          ContentLength: buffer.length,
        }),
      );
      return media;
    },
    async read(upload) {
      if (!upload.storage) return createReadStream(localPath(upload.filename));
      const result = await send(
        new GetObjectCommand(objectInput(JSON.parse(upload.storage))),
      );
      return result.Body;
    },
    async readBuffer(upload) {
      if (!upload.storage) return readFile(localPath(upload.filename));
      const stream = await this.read(upload);
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > 30 * 1024 * 1024)
            throw new Error("Input image exceeds the size limit.");
          chunks.push(Buffer.from(chunk));
        }
      } catch {
        stream.destroy?.();
        throw unavailable();
      }
      return Buffer.concat(chunks);
    },
    async deleteUpload(upload) {
      if (upload.storage) await this.deleteObject(JSON.parse(upload.storage));
      try {
        await unlink(localPath(upload.filename));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async deleteObject(media) {
      try {
        await send(new DeleteObjectCommand(objectInput(media)));
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    },
    async saveResult(job, url) {
      const directory = await mkdtemp(join(tmpdir(), "ai-media-"));
      try {
        const filename = join(directory, "result");
        const file = await downloader(
          url,
          filename,
          JSON.parse(job.request).mode,
        );
        const media = {
          bucket: config.bucket,
          key: `generated/${file.mime.startsWith("image/") ? "images" : "videos"}/${job.user_id}/${job.id}.${file.ext}`,
          mime: file.mime,
          bytes: file.bytes,
        };
        const body = createReadStream(filename);
        try {
          await send(
            new PutObjectCommand({
              ...objectInput(media),
              Body: body,
              ContentType: file.mime,
              ContentLength: file.bytes,
            }),
          );
        } finally {
          body.destroy();
        }
        return media;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async inputUrl(upload) {
      if (!s3 || !upload.storage) throw unavailable();
      try {
        // Covers the queue start deadline plus inference time. No public bucket needed.
        return await signer(
          s3,
          new GetObjectCommand(objectInput(JSON.parse(upload.storage))),
          { expiresIn: 14400 },
        );
      } catch {
        throw unavailable();
      }
    },
    async resultUrl(media) {
      if (!s3) throw unavailable();
      // Stable within a five-minute window so polling does not reload video playback.
      const signingDate = new Date(Math.floor(Date.now() / 300000) * 300000);
      try {
        return await signer(s3, new GetObjectCommand(objectInput(media)), {
          expiresIn: 3600,
          signingDate,
        });
      } catch {
        throw unavailable();
      }
    },
    close() {
      if (!client) s3?.destroy();
    },
  };
}
