# Creator Studio backend

Fastify API with Neon PostgreSQL and private R2 media storage. SQLite remains
available for offline development. Server source is in `server/`; tests are in
`tests/`; local SQLite files, credentials, encryption key, and backups are in `data/`.
PostgreSQL is enabled by DATABASE_URL in backend/.env.

Direct fal.ai generation is supported with economical image, photo-editing and
video presets. Set FAL_KEY and run `npm run fal:setup`; see [fal integration](docs/FAL.md).

```sh
npm ci
npm run setup
npm start
```

Requires Node 22.13 or later and the sibling `shared/` folder. Setup preserves
existing accounts. By default the API listens on port 4000 and serves the sibling
`frontend/dist/` build when present. The API also runs without a frontend build.

Use `npm test` for isolated backend tests. See [operations](docs/OPERATIONS.md),
[API contract](docs/API.md), and the [workspace instructions](../README.md).

R2 image/video storage is supported through a private bucket. See
[R2 setup, verification, and media migration](docs/R2.md). See [Neon setup and data migration](docs/NEON.md) before initializing a new database
when preserving existing accounts.
