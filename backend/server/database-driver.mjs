import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

// SQL is authored with positional ? parameters for the SQLite development backend.
// Convert placeholders only outside quoted SQL strings/identifiers.
export function postgresSql(sql) {
  let quote = null,
    result = "",
    count = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      result += c;
      if (c === quote) {
        if (sql[i + 1] === quote) result += sql[++i];
        else quote = null;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      result += c;
    } else result += c === "?" ? "$" + ++count : c;
  }
  result = result.replace(/instr\(content,/g, "strpos(content,");
  if (
    /^\s*INSERT INTO revisions\b/i.test(result) &&
    !/\bRETURNING\b/i.test(result)
  )
    result += " RETURNING id";
  return result;
}

export function sqliteDriver(filename) {
  const raw = new DatabaseSync(filename),
    context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  async function exclusive(fn) {
    if (context.getStore()) return fn();
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await context.run(true, fn);
    } finally {
      release();
    }
  }
  return {
    kind: "sqlite",
    prepare(sql) {
      const statement = raw.prepare(sql);
      return Object.fromEntries(
        ["get", "all", "run"].map((method) => [
          method,
          (...args) => exclusive(() => statement[method](...args)),
        ]),
      );
    },
    exec(sql) {
      return exclusive(() => raw.exec(sql));
    },
    transaction(fn) {
      if (context.getStore())
        throw new Error("Nested transactions are not supported.");
      return exclusive(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const value = await fn();
          raw.exec("COMMIT");
          return value;
        } catch (error) {
          raw.exec("ROLLBACK");
          throw error;
        }
      });
    },
    close() {
      return exclusive(() => raw.close());
    },
  };
}

export function postgresDriver(connectionString, { pool: injectedPool } = {}) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Set a valid DATABASE_URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  const neon = url.hostname.endsWith(".neon.tech");
  if (neon) url.searchParams.set("sslmode", "verify-full");
  const pool =
    injectedPool ||
    new pg.Pool({
      connectionString: url.href,
      enableChannelBinding: true,
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
      types: {
        getTypeParser(oid, format) {
          if (oid === 20 && format !== "binary")
            return (value) => {
              const number = Number(value);
              if (!Number.isSafeInteger(number))
                throw new Error("Database integer exceeds safe range.");
              return number;
            };
          return pg.types.getTypeParser(oid, format);
        },
      },
    });
  pool.on("error", () => {
    /* Idle client failures are retried by the pool; no secrets logged. */
  });
  const context = new AsyncLocalStorage();
  const query = (sql, args = []) =>
    (context.getStore() || pool).query(sql, args);
  return {
    kind: "postgres",
    prepare(sql) {
      const text = postgresSql(sql);
      return {
        async get(...args) {
          return (await query(text, args)).rows[0];
        },
        async all(...args) {
          return (await query(text, args)).rows;
        },
        async run(...args) {
          const result = await query(text, args);
          return {
            changes: result.rowCount,
            lastInsertRowid: result.rows[0]?.id,
          };
        },
      };
    },
    exec(sql) {
      return query(sql);
    },
    async transaction(fn) {
      if (context.getStore())
        throw new Error("Nested transactions are not supported.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Preserve the previous single-writer transaction semantics for coins,
        // idempotency and publishing across concurrent API requests.
        await client.query("SELECT pg_advisory_xact_lock(1789526016)");
        const value = await context.run(client, fn);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    },
  };
}
