import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, cpSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const dir = resolve(process.env.DATA_DIR || "./data"),
  target = join(dir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(target, { recursive: true, mode: 0o700 });
if (process.env.DATABASE_URL) {
  await new Promise((resolve, reject) => {
    const command = spawn(
      "pg_dump",
      ["--format=custom", "--file", join(target, "postgres.dump")],
      {
        env: {
          ...process.env,
          PGDATABASE:
            process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
        },
        stdio: "ignore",
      },
    );
    command.on("error", () =>
      reject(
        new Error(
          "PostgreSQL backup failed. Install pg_dump and check database access.",
        ),
      ),
    );
    command.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "PostgreSQL backup failed. Check pg_dump version and database access.",
            ),
          ),
    );
  });
} else {
  const db = new DatabaseSync(join(dir, "studio.sqlite"));
  try {
    await backup(db, join(target, "studio.sqlite"));
  } finally {
    db.close();
  }
}
if (existsSync(join(dir, "uploads")))
  cpSync(join(dir, "uploads"), join(target, "uploads"), { recursive: true });
cpSync(join(dir, "master.key"), join(target, "master.key"));
console.log(
  "Backup created: " +
    target +
    ". R2 objects require a separate backup. Pause uploads/deletions for a fully consistent media snapshot.",
);
