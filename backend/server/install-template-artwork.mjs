import { resolve, join } from "node:path";
import { connectDatabase } from "./db.mjs";
import { createStorage } from "./storage.mjs";
import { migrateBundledMedia } from "./bundled-media.mjs";
import { publishTemplateArtwork } from "./template-artwork.mjs";

// Storage and catalog maintenance only. Never imports or starts a generation worker.
const dataDir = resolve(process.env.DATA_DIR || "./data");
let db, storage;
try {
  storage = createStorage({ dataDir });
  if (storage.mode !== "r2") throw new Error("R2 is required.");
  db = await connectDatabase(join(dataDir, "studio.sqlite"), { seed: false });
  if (
    await db
      .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
      .get()
  )
    throw new Error("Stop active generation jobs before installing artwork.");
  const uploaded = await migrateBundledMedia(db, storage);
  const result = await publishTemplateArtwork(db, {
    backupDir: join(dataDir, "backups"),
  });
  console.log(
    JSON.stringify({
      ...result,
      uploaded,
      templateImages: 30,
      providerCalls: 0,
    }),
  );
} catch (error) {
  console.error("Artwork installation stopped:", error.message);
  process.exitCode = 1;
} finally {
  storage?.close();
  await db?.close();
}
