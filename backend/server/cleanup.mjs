import { resolve, join } from "node:path";
import { connectDatabase } from "./db.mjs";
import { createStorage } from "./storage.mjs";
import { cleanupMedia } from "./cleanup-media.mjs";
const dir = resolve(process.env.DATA_DIR || "./data"),
  db = await connectDatabase(join(dir, "studio.sqlite"));
const storage = createStorage({ dataDir: dir });
let removed;
try {
  removed = await cleanupMedia(db, storage);
} finally {
  storage.close();
  await db.close();
}
console.log(
  "Removed " +
    removed +
    " private input photos older than 72 hours and expired sessions. Active job inputs were retained.",
);
