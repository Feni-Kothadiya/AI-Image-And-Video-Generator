import { openPostgresDatabase } from "./db.mjs";

let db;
try {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("PostgreSQL connection is required.");
  db = await openPostgresDatabase(url, { seed: false });
  console.log(
    "PostgreSQL tables are ready. No local accounts or application records were imported.",
  );
} catch {
  console.error(
    "Database schema setup failed. Check the connection and schema permissions.",
  );
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
