import https from "node:https";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { publicIPv4, safeResultUrl } from "./gateway.mjs";

export function detectMedia(buffer, video = false) {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", ext: "png" };
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return { mime: "image/jpeg", ext: "jpg" };
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  if (
    video &&
    buffer.length >= 12 &&
    buffer.readUInt32BE(0) >= 16 &&
    buffer.subarray(4, 8).toString() === "ftyp" &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(
      buffer.subarray(8, 12).toString(),
    )
  )
    return { mime: "video/mp4", ext: "mp4" };
  throw new Error("Unsupported media file. Expected PNG, JPEG, WebP, or MP4.");
}

// Each redirect is checked and DNS is pinned to prevent fetching private services.
export async function openMediaUrl(
  value,
  {
    dnsLookup = lookup,
    request = https.request,
    signal = AbortSignal.timeout(120000),
  } = {},
  redirects = 0,
) {
  if (!safeResultUrl(value)) throw new Error("Invalid media URL.");
  const url = new URL(value);
  if (url.port && url.port !== "443") throw new Error("Invalid media port.");
  const addresses = await dnsLookup(url.hostname, { family: 4, all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicIPv4(address))
  )
    throw new Error("Media destination is not public.");
  const response = await new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        timeout: 30000,
        headers: { "Accept-Encoding": "identity" },
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [addresses[0]])
            : callback(null, addresses[0].address, 4),
      },
      resolve,
    );
    req.on("error", () => reject(new Error("Media download failed.")));
    req.on("timeout", () =>
      req.destroy(new Error("Media download timed out.")),
    );
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 3 || !response.headers.location)
      throw new Error("Too many media redirects.");
    return openMediaUrl(
      new URL(response.headers.location, url).href,
      { dnsLookup, request, signal },
      redirects + 1,
    );
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error("Media download failed.");
  }
  return response;
}

export async function downloadMedia(
  url,
  filename,
  mode,
  { openUrl = openMediaUrl, maxBytes = 256 * 1024 * 1024 } = {},
) {
  const response = await openUrl(url);
  if (Number(response.headers["content-length"]) > maxBytes) {
    response.destroy();
    throw new Error("Generated media exceeds the storage limit.");
  }
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxBytes
          ? new Error("Generated media exceeds the storage limit.")
          : null,
        chunk,
      );
    },
  });
  await pipeline(
    response,
    limit,
    createWriteStream(filename, { flags: "wx", mode: 0o600 }),
  );
  const file = await open(filename, "r");
  let media;
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    media = detectMedia(header.subarray(0, bytesRead), true);
  } finally {
    await file.close();
  }
  if ((mode === "image") !== media.mime.startsWith("image/"))
    throw new Error("Provider returned the wrong media type.");
  return { ...media, bytes };
}
