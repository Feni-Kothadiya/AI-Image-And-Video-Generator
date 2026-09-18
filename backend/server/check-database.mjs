import { postgresDriver } from "./database-driver.mjs";

let db;
try {
  if (!process.env.DATABASE_URL) throw new Error("Database not configured.");
  db = postgresDriver(process.env.DATABASE_URL);
  await db.prepare("SELECT 1 AS ok").get();
  console.log("PostgreSQL connection verified. No data was changed.");
} catch {
  console.error(
    "PostgreSQL connection failed. Check DATABASE_URL, network access, and database availability.",
  );
  process.exitCode = 1;
} finally {
  if (db) await db.close();
}
