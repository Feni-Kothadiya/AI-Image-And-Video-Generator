import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { decrypt } from "./security.mjs";
import { fail } from "./schema.mjs";
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19))
  );
}
export function validateGatewayUrl(value, allowedHosts = "") {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(400, "Enter a valid gateway HTTPS URL.");
  }
  const allowed = allowedHosts
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== "443") ||
    !allowed.includes(url.hostname.toLowerCase()) ||
    isIP(url.hostname)
  )
    fail(
      400,
      "Gateway must use HTTPS and a hostname listed in AI_ALLOWED_HOSTS on the server.",
    );
  return url;
}
export function safeResultUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal") ||
      url.hostname.startsWith("[") ||
      (isIP(url.hostname) && !publicIPv4(url.hostname))
    )
      return false;
    return value.length <= 4096;
  } catch {
    return false;
  }
}
async function request(url, method, secret, body, idempotencyKey) {
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw new Error("Gateway DNS did not resolve to a public address.");
  const data = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [addresses[0]])
            : callback(null, addresses[0].address, 4),
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          if (bytes > 1024 * 1024) {
            req.destroy(new Error("Gateway response too large."));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error("Gateway request failed."));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch {
            reject(new Error("Invalid gateway response."));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Gateway timed out.")));
    req.on("error", reject);
    req.end(data);
  });
}
// The eventual vendor adapter implements this small contract. No vendor is assumed.
export function createGateway({ db, key, storage, allowedHosts }) {
  return {
    async run(job, config) {
      const root = validateGatewayUrl(config.gatewayUrl, allowedHosts);
      const secret = decrypt(config.secret, key);
      if (!secret) throw new Error("Provider credentials are missing.");
      const input = JSON.parse(job.request);
      let output;
      if (job.provider_id)
        output = await request(
          new URL(
            root.href.replace(/\/$/, "") +
              "/jobs/" +
              encodeURIComponent(job.provider_id),
          ),
          "GET",
          secret,
        );
      else {
        const images = await Promise.all(
          input.uploadIds.map(async (id) => {
            const upload = await db
              .prepare("SELECT * FROM uploads WHERE id=? AND user_id=?")
              .get(id, job.user_id);
            if (!upload) throw new Error("Input photo is no longer available.");
            return {
              mimeType: upload.mime,
              data: (await storage.readBuffer(upload)).toString("base64"),
            };
          }),
        );
        output = await request(
          new URL(root.href.replace(/\/$/, "") + "/jobs"),
          "POST",
          secret,
          {
            ...input,
            uploadIds: undefined,
            images,
            model: config.models[input.mode],
            clientJobId: job.id,
          },
          job.id,
        );
      }
      if (
        !["queued", "processing", "succeeded", "failed"].includes(output.status)
      )
        throw new Error("Invalid provider job status.");
      if (output.status === "succeeded" && !safeResultUrl(output.resultUrl))
        throw new Error("Invalid provider result URL.");
      if (
        ["queued", "processing"].includes(output.status) &&
        (typeof output.id !== "string" || !output.id || output.id.length > 200)
      )
        throw new Error("Provider did not return a job ID.");
      return {
        status: output.status,
        id: output.id,
        resultUrl: output.resultUrl,
      };
    },
  };
}
