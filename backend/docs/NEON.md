# Neon PostgreSQL

The backend uses PostgreSQL whenever DATABASE_URL is configured. Without it, the
same API uses SQLite for offline development. Media files are stored separately in
R2; PostgreSQL holds accounts, coins, sessions, content, jobs, and media references.

## Configuration

Keep both connection strings in backend/.env or deployment secrets:

```dotenv
DATABASE_URL=postgresql://ROLE:PASSWORD@POOLED_HOST/DATABASE?sslmode=require&channel_binding=require
DIRECT_DATABASE_URL=postgresql://ROLE:PASSWORD@DIRECT_HOST/DATABASE?sslmode=require&channel_binding=require
```

Use the pooled Neon URL for the running API, and the direct URL for schema setup,
imports and backups. Preserve Neon's SSL parameters. The driver enables channel
binding and verifies TLS certificates for Neon. Connection values are never sent
to the app or the dashboard.

From backend/:

```sh
npm run database:check
npm run database:setup
```

The check runs SELECT 1 only. Schema setup creates empty application tables; it
does not import local records or create an administrator. Both commands report
status without printing connection strings or database errors containing details.

## Preserve existing SQLite data

Do this before starting the API or running npm run setup on a fresh Neon database:

1. Stop the backend and finish/cancel any queued or processing jobs.
2. Confirm that you intend to transfer the existing accounts, password hashes,
   wallets, sessions, content, reports and job history to your Neon project.
3. Run `npm run database:migrate` from backend/.

The importer creates a consistent local SQLite backup and copies the existing
provider encryption key into that backup. It reads the original SQLite database
without changing it. PostgreSQL imports happen in one transaction. It refuses to
overwrite an already populated application database and records completed imports
so a repeat run does not duplicate accounts or balances. Initial login details
remain in the existing local credentials file.

If migration has not been approved, leave the local records in place and use only
database:check/database:setup. Starting the backend seeds initial app content;
the importer deliberately refuses to overwrite those records afterward.

After the database import, `npm run storage:migrate` can move local images into R2.
Keep backend/data/master.key: existing encrypted AI-provider credentials depend
on it even when the database is hosted in Neon.

## Fresh installation

If there is no local data to preserve, run npm run setup after configuring Neon.
It seeds the default app content and creates an administrator if none exists.
An existing local credentials file blocks generating an unrelated new password;
import your old database or explicitly set ADMIN_EMAIL and ADMIN_PASSWORD for a
fresh administrator. Existing accounts are never replaced by setup.

## Transactions and deployment

Each transaction uses a single PostgreSQL client from the pool. A transaction-level
advisory lock preserves the single-writer behavior previously used for wallet
credits, job idempotency and publishing revisions. Queries are parameterized.
This favors correctness for the current single-server deployment; the job worker
still requires one backend instance until multi-worker leasing is implemented.

Use a persistent backend data directory for the encryption key and any legacy
local files. R2 and Neon do not automatically make this directory disposable.

## Backups and tests

`npm run backup` uses pg_dump when DATABASE_URL is set, choosing
DIRECT_DATABASE_URL when available. Install a pg_dump version compatible with
your Neon PostgreSQL version. The archive includes the configured database,
local files, and provider encryption key; R2 objects need their own backup policy.

`npm test` uses temporary SQLite databases and simulated R2, without loading .env.
For real PostgreSQL regression tests, set TEST_POSTGRES_URL to a dedicated local
test database. Tests create and remove isolated schemas. Never point this variable
at your live application database.

References: [Neon pooling](https://neon.com/docs/connect/connection-pooling),
[PostgreSQL transactions](https://node-postgres.com/features/transactions).
