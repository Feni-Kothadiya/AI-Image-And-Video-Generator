import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { postgresDriver, postgresSql } from "../server/database-driver.mjs";
import {
  openDatabase,
  openPostgresDatabase,
  credit,
  transaction,
  now,
  getSetting,
} from "../server/db.mjs";
import { importSqlite } from "../server/import-sqlite.mjs";

test("PostgreSQL placeholders preserve question marks inside quoted SQL", () => {
  assert.equal(
    postgresSql("SELECT '?' AS label, ? AS value, 'it''s ?' AS text"),
    "SELECT '?' AS label, $1 AS value, 'it''s ?' AS text",
  );
});

test(
  "SQLite import preserves accounts and coins, resets sequences and refuses overwrites",
  { skip: !process.env.TEST_POSTGRES_URL },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-import-test-"));
    const file = join(dir, "source.sqlite");
    const control = postgresDriver(process.env.TEST_POSTGRES_URL);
    const schema = "import_" + randomUUID().replaceAll("-", "");
    await control.exec("CREATE SCHEMA " + schema);
    const url = new URL(process.env.TEST_POSTGRES_URL);
    url.searchParams.set("options", "-c search_path=" + schema);
    let source, target;
    try {
      source = await openDatabase(file);
      await source
        .prepare(
          "INSERT INTO users(id,email,password,role,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          "test-admin",
          "admin@example.com",
          "test-password-hash",
          "admin",
          now(),
        );
      await source
        .prepare("INSERT INTO users(id,created_at) VALUES(?,?)")
        .run("test-user", now());
      await transaction(source, async () => {
        await credit(source, "test-user", 123, "Test balance", "initial");
      });
      const expected = await getSetting(source, "published");
      await source.close();
      source = null;
      target = await openPostgresDatabase(url.href, { seed: false });
      const result = await importSqlite(target, file);
      assert.equal(result.users, 2);
      assert.equal(
        (
          await target
            .prepare("SELECT coins FROM users WHERE id='test-user'")
            .get()
        ).coins,
        123,
      );
      assert.equal(
        (
          await target
            .prepare("SELECT password FROM users WHERE id='test-admin'")
            .get()
        ).password,
        "test-password-hash",
      );
      assert.deepEqual(await getSetting(target, "published"), expected);
      const revision = await target
        .prepare(
          "INSERT INTO revisions(content,note,actor,created_at) VALUES(?,?,?,?)",
        )
        .run("{}", "test", "test", now());
      assert.equal(revision.lastInsertRowid, 2);
      assert.equal((await importSqlite(target, file)).alreadyImported, true);
      await target
        .prepare("DELETE FROM schema_migrations WHERE version=100")
        .run();
      await assert.rejects(importSqlite(target, file), /will not overwrite/);
      assert.equal(
        (await target.prepare("SELECT count(*) AS n FROM users").get()).n,
        2,
      );
    } finally {
      if (source) await source.close();
      if (target) await target.close();
      await control.exec("DROP SCHEMA " + schema + " CASCADE");
      await control.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
