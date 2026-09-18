import { resolve, join } from "node:path";
import { connectDatabase, setSetting } from "./db.mjs";
import { storageConfig } from "./storage.mjs";
import { falSettings } from "./fal.mjs";
let db;
try {
  if (!process.env.FAL_KEY?.trim()) throw new Error("Missing FAL_KEY");
  if (storageConfig(process.env).mode !== "r2") throw new Error("R2 required");
  db = await connectDatabase(
    join(resolve(process.env.DATA_DIR || "./data"), "studio.sqlite"),
  );
  await db.transaction(async () => {
    if (
      await db
        .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
        .get()
    )
      throw new Error("Active jobs");
    await setSetting(db, "integration", falSettings);
  });
  console.log(
    "fal configured: Schnell images, Klein photo edits, LongCat Distilled videos. API key stays in the backend environment. No generation was submitted.",
  );
} catch {
  console.error(
    "fal setup failed. Check FAL_KEY, R2, database access, and finish active jobs first. Credentials were not printed.",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
}
