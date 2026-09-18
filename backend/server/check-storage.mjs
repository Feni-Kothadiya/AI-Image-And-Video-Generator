import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createStorage } from "./storage.mjs";

// Explicit opt-in live check. Prints no credentials, object URLs, or SDK errors.
const storage = createStorage({
  dataDir: resolve(process.env.DATA_DIR || "./data"),
});
if (storage.mode !== "r2")
  throw new Error("Configure R2 before running the storage check.");
const filename = randomUUID() + ".png";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
let stored;
try {
  stored = await storage.putUpload(
    filename,
    png,
    "image/png",
    false,
    "connection-check",
  );
  const result = await storage.readBuffer({
    filename,
    storage: JSON.stringify(stored),
  });
  if (!result.equals(png)) throw new Error("Storage verification failed.");
  await storage.deleteObject(stored);
  stored = null;
  console.log("R2 upload, download, and deletion verified.");
} catch {
  console.error(
    "R2 check failed. Verify bucket, endpoint, credentials, and Object Read & Write permission.",
  );
  process.exitCode = 1;
} finally {
  if (stored) {
    try {
      await storage.deleteObject(stored);
    } catch {
      console.error(
        "The temporary connection-check image could not be removed; retry cleanup in the bucket.",
      );
    }
  }
  storage.close();
}
