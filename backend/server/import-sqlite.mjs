import { DatabaseSync } from "node:sqlite";

const tables = [
  "users",
  "settings",
  "revisions",
  "ledger",
  "sessions",
  "uploads",
  "jobs",
  "pending_media",
  "fal_requests",
  "reports",
  "audit",
  "purchases",
  "billing_accounts",
  "play_purchases",
  "billing_debts",
];

export async function importSqlite(db, filename) {
  if (db.kind !== "postgres") throw new Error("Import requires PostgreSQL.");
  if (
    await db.prepare("SELECT 1 FROM schema_migrations WHERE version=100").get()
  )
    return { alreadyImported: true };
  const source = new DatabaseSync(filename, { readOnly: true });
  const rows = {};
  try {
    source.exec("BEGIN");
    if (
      source
        .prepare("SELECT 1 FROM jobs WHERE status IN ('queued','processing')")
        .get()
    )
      throw new Error(
        "Finish or cancel local jobs and stop the backend before importing.",
      );
    for (const table of tables) {
      rows[table] = source
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
        ? source.prepare(`SELECT * FROM ${table}`).all()
        : [];
    }
    source.exec("COMMIT");
  } finally {
    source.close();
  }
  return db.transaction(async () => {
    for (const table of tables) {
      if (await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
        throw new Error(
          "PostgreSQL already contains application data. Import will not overwrite it.",
        );
    }
    for (const table of tables) {
      for (const row of rows[table]) {
        const columns = Object.keys(row);
        if (columns.some((name) => !/^[a-z_]+$/.test(name)))
          throw new Error("Unexpected source column.");
        const placeholders = columns.map(() => "?").join(",");
        await db
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${placeholders})`,
          )
          .run(...Object.values(row));
      }
    }
    for (const table of ["revisions", "audit"]) {
      await db.exec(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS(SELECT 1 FROM ${table}))`,
      );
    }
    await db
      .prepare("INSERT INTO schema_migrations VALUES(100,?)")
      .run(new Date().toISOString());
    return {
      users: rows.users.length,
      uploads: rows.uploads.length,
      jobs: rows.jobs.length,
    };
  });
}
