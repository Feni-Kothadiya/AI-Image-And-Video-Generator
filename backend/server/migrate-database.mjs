import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { openPostgresDatabase } from "./db.mjs";
import { importSqlite } from "./import-sqlite.mjs";

let target;
try {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("PostgreSQL connection is not configured.");
  const dir = resolve(process.env.DATA_DIR || "./data");
  const file = join(dir, "studio.sqlite");
  if (!existsSync(file))
    throw new Error("Local SQLite database was not found.");
  // A consistent local rollback snapshot includes the provider encryption key.
  const location = join(dir, "backups", "before-neon-" + Date.now());
  mkdirSync(location, { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    await backup(source, join(location, "studio.sqlite"));
  } finally {
    source.close();
  }
  if (existsSync(join(dir, "master.key")))
    copyFileSync(join(dir, "master.key"), join(location, "master.key"));
  target = await openPostgresDatabase(url, { seed: false });
  const result = await importSqlite(target, file);
  console.log(
    result.alreadyImported
      ? "SQLite data was already imported; no changes made."
      : `Imported ${result.users} accounts, ${result.uploads} upload records and ${result.jobs} jobs into PostgreSQL. Local SQLite data and credentials were preserved.`,
  );
} catch (error) {
  // Print only our own known operational messages, never driver URLs or details.
  const safe = [
    "Finish or cancel local jobs and stop the backend before importing.",
    "PostgreSQL already contains application data. Import will not overwrite it.",
    "Local SQLite database was not found.",
  ];
  console.error(
    safe.includes(error.message)
      ? error.message
      : "Database import failed. Check connectivity and permissions. Local data is preserved; an incomplete import rolls back.",
  );
  process.exitCode = 1;
} finally {
  if (target) await target.close();
}
