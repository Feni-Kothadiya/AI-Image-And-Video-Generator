# AI Image and Video workspace

The mobile app, backend API, and web admin frontend are separate projects:

```text
ai-image-video-generator/   Expo Android app and mobile tests
backend/                    Fastify API, Neon/R2 integration, tests, operations docs
frontend/                   React/Vite admin dashboard and its build output
shared/                     Default content and public preview artwork
reference-review/           Original app research and screenshots
```

Use Node 22.13 or later. On a Mac with nvm, run `nvm use` in this folder
(or `nvm install` if the version in `.nvmrc` is not installed).

For hosting, use the root `render.yaml` and follow the
[Render deployment guide](backend/docs/RENDER.md). Its initial configuration keeps
generation workers and Google Play purchases paused.

## Database and media configuration

Neon PostgreSQL and private Cloudflare R2 are configured through backend/.env.
See [Neon setup and migration](backend/docs/NEON.md) and [R2 setup](backend/docs/R2.md).
When moving existing accounts from SQLite, import them before running setup or
starting the backend against an empty Neon database.

## Run the dashboard and backend

From this workspace folder:

```sh
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix backend run setup
npm --prefix backend start
```

Open http://localhost:4000. Initial login details are in
`backend/data/admin-credentials.txt`. Existing accounts, database, encryption key,
and backups were moved with the backend. Setup preserves an existing administrator.

The backend serves `frontend/dist/` and the API from the same origin. Build frontend
changes with `npm --prefix frontend run build`. To serve a build from elsewhere,
set `FRONTEND_DIST` in the backend environment.

On Windows, `backend/start.ps1 -Setup` installs missing dependencies, builds the
frontend, initializes the backend if needed, and starts it.

## Develop the frontend separately

Copy `backend/.env.example` to `backend/.env` and set
`ADMIN_ORIGIN=http://localhost:5173`. Start the backend, then in another terminal:

```sh
npm --prefix frontend run dev
```

Open http://localhost:5173. Vite proxies API, media, and seed-artwork requests to
port 4000. Use `localhost` consistently for the dashboard origin. Restore
`ADMIN_ORIGIN=http://localhost:4000` when using the built dashboard on port 4000.

## Run the mobile app

In another terminal:

```sh
npm --prefix ai-image-video-generator ci
npm --prefix ai-image-video-generator start
```

The app's `.env.example` documents `EXPO_PUBLIC_API_URL`; set it to a backend address
reachable from the device. The existing USB scripts remain in the mobile folder.
For the browser preview, run `EXPO_WEB_PREVIEW=1 npm --prefix ai-image-video-generator run web`.

## Checks

```sh
npm --prefix backend test
npm --prefix frontend run build
npm --prefix ai-image-video-generator run typecheck
npm --prefix ai-image-video-generator test
npm --prefix ai-image-video-generator run export:android
```

Keep `shared/` next to the app and backend: both load `shared/default-config.json`.
The app watches this shared directory through Metro. The API serves public preview
artwork from `shared/assets/`; mobile icons and bundled artwork stay in the app's
`assets/`. `node ai-image-video-generator/scripts/seed-content.cjs` regenerates
common defaults and copies updated preview artwork from the app.

The existing Git repository remains inside `ai-image-video-generator/`. The new
sibling projects and shared directory are outside that repository; include them
when backing up or setting up version control for the whole workspace.

See [backend operations](backend/docs/OPERATIONS.md) and the
[mobile app notes](ai-image-video-generator/README.md) for service limitations and deployment.
