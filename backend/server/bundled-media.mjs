import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getSetting, setSetting } from "./db.mjs";

export const templateArtwork = JSON.parse(
  readFileSync(
    new URL("../../shared/template-artwork/manifest.json", import.meta.url),
    "utf8",
  ),
);
export const bundledNames = [
  "brand-icon.png",
  "portrait.png",
  "city.png",
  "couple.png",
  "flowers.png",
  ...templateArtwork.map((asset) => asset.name),
];
export const bundledDirectory = fileURLToPath(
  new URL("../../shared/assets", import.meta.url),
);
const artworkDirectory = fileURLToPath(
  new URL("../../shared/template-artwork", import.meta.url),
);
export function bundledPath(name) {
  if (!bundledNames.includes(name)) throw new Error("Unknown bundled image.");
  const asset = templateArtwork.find((asset) => asset.name === name);
  return asset
    ? join(artworkDirectory, asset.file)
    : join(bundledDirectory, name);
}

// Run during the same maintenance window as the other media migrations.
export async function migrateBundledMedia(db, storage) {
  if (storage.mode !== "r2") throw new Error("R2 is required.");
  const media = (await getSetting(db, "bundled_media")) || {};
  let copied = 0;
  for (const name of bundledNames) {
    const bytes = await readFile(bundledPath(name));
    const existing = media[name];
    const stored =
      existing ||
      (await storage.putUpload("seed-" + name, bytes, "image/png", true, null));
    const remote = await storage.readBuffer({
      storage: JSON.stringify(stored),
    });
    if (!bytes.equals(remote))
      throw new Error("Bundled image verification failed.");
    if (!existing) {
      media[name] = stored;
      await setSetting(db, "bundled_media", media);
      copied++;
    }
  }
  return copied;
}
