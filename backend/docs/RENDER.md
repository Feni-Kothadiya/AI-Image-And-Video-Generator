# Deploy to Render

This workspace includes a Render Blueprint at `render.yaml`. It hosts the backend
and compiled admin dashboard together, and uses the existing Neon database and R2
bucket. The blueprint selects a **Free** web service in Virginia, near the existing
US East Neon database, with no persistent disk. This configuration is for testing;
free services can sleep and restart. All durable application data must remain in
Neon/R2, and the original encryption key must remain in the Render environment.

## 1. Prepare the repository

The connected Git repository must contain these paths at its root:

```text
render.yaml
.gitignore
.nvmrc
backend/       # including package-lock.json
frontend/      # including package-lock.json
shared/
```

The mobile app's existing Git repository alone does not contain the backend.
Use a private deployment repository containing the paths above. Keep the existing
directory layout and leave Render's Root Directory blank. Do not include `.env`,
`backend/data`, service-account JSON, node_modules, or backups in Git.

## 2. Prepare environment values privately

Use the existing database, bucket, and encryption key so existing records remain
readable. Do not create a new Neon database or repeat the data migration.

| Render variable | Value |
| --- | --- |
| `DATABASE_URL` | Existing Neon pooled PostgreSQL URL, including its SSL parameters |
| `R2_ENDPOINT` | Existing Cloudflare S3 account endpoint |
| `R2_BUCKET` | Existing media bucket name |
| `R2_ACCESS_KEY_ID` | Existing R2 access key ID |
| `R2_SECRET_ACCESS_KEY` | Existing R2 secret access key |
| `MASTER_KEY_BASE64` | Base64 encoding of the existing `backend/data/master.key` |

On your Mac, from the workspace root, this command copies the encoded master key
to your clipboard without printing it. Run it yourself and paste only into
Render's `MASTER_KEY_BASE64` secret field:

```sh
node -e 'process.stdout.write(require("node:fs").readFileSync("backend/data/master.key").toString("base64"))' | pbcopy
```

Keep an independent secure backup of the original key. Encoding it is not key
rotation. Startup restores the key to `/tmp/ai-creator-data/master.key` if needed, and refuses
to replace a different key already on disk. A valid but incorrect key cannot be
detected on an empty disk, so copy the original exactly.

On Windows, run this in PowerShell from the workspace root. It validates the
existing file and copies one encoded value without displaying the secret:

```powershell
$taskKeyPath = Join-Path (Get-Location) 'backend/data/master.key'
$taskKeyBytes = [System.IO.File]::ReadAllBytes($taskKeyPath)
if ($taskKeyBytes.Length -ne 32) { throw 'The original master.key must contain exactly 32 bytes.' }
$taskEncodedKey = [Convert]::ToBase64String($taskKeyBytes)
Set-Clipboard -Value $taskEncodedKey
Write-Host "Copied one $($taskEncodedKey.Length)-character key value."
```

### Troubleshooting master-key startup errors

The value must be one 44-character standard Base64 string ending in `=`.
Characters `+` and `/` are valid; do not replace them. Clear the whole Render
`MASTER_KEY_BASE64` value field before pasting once. Do not include quotes,
`MASTER_KEY_BASE64=`, extra spaces inside the value, or a second encoded key.

Set it under the web service's **Environment Variables**, using the exact name
`MASTER_KEY_BASE64`, then choose **Save and deploy**. A secret file or an ignored
local `.env` does not populate this environment variable. A service-level value
overrides a linked environment group's value, so check the web service itself.

Startup errors report only the problem and character count, never the secret.
An 88-character value contains twice the expected number of characters, often
from pasting twice. If the logs still show the older generic error, deploy the
commit containing these diagnostics. Do not bypass validation or generate a new
key to use with an existing database; restore the matching original from backup.

## 3. Create the Render service

1. Open Render and choose **New → Blueprint**.
2. Connect the private Git repository and select its deployment branch.
3. Use `render.yaml` as the Blueprint path.
4. Enter the six environment values above when prompted.
5. Confirm the web service plan is **Free**, with no disk, then create the Blueprint.

The build installs backend dependencies and builds `frontend/dist`. Startup uses
`node backend/server/render-start.mjs`. It requires Neon and R2 settings before
opening the database, binds to `0.0.0.0`, and uses Render's supplied `PORT`.
`ADMIN_ORIGIN` defaults to Render's `RENDER_EXTERNAL_URL`, so the dashboard and API
use the same HTTPS origin. For a custom domain, set `ADMIN_ORIGIN` to that exact
HTTPS origin without a trailing slash.

`DATA_DIR=/tmp/ai-creator-data` is temporary scratch space; it is recreated after
local files are lost. The encryption key is restored from `MASTER_KEY_BASE64`
before the database is opened. Keep one instance; the embedded job worker is not
designed for multiple simultaneous server processes. Stop any local backend
connected to the same database before enabling cloud workers.

Automatic deploys are off; use **Manual Deploy → Deploy latest commit** for later
code updates. Blueprint configuration changes still require a Blueprint sync.

## 4. Verify the first deployment without AI spending

The blueprint sets `BACKGROUND_WORKERS_ENABLED=0` and `PLAY_BILLING_ENABLED=0`.
Do not add `FAL_KEY` yet. Background generation and billing reconciliation remain
paused; keep the dashboard's generation integration disabled during these checks.
This deployment is for setup verification, not public generation or purchases.

1. Wait for Render to show **Live**.
2. Open `https://YOUR-SERVICE.onrender.com/api/health`; expect `status: "ok"`
   and `database: true`. This endpoint checks the database, not R2 or billing.
3. Open the base URL and log in with the existing administrator account.
4. Check existing templates and images. Test a media upload and view the result;
   this uses R2 storage requests but does not invoke the AI provider.
5. Restart the service and confirm login and media still work.
6. Set the mobile app's `EXPO_PUBLIC_API_URL` to the Render HTTPS base URL and
   rebuild the app.

Existing R2-backed media stays in the same bucket. If any database records still
refer to local uploads, migrate those files to R2 from the machine that has the
original files before relying on the hosted app; see [R2 migration](R2.md).
Copying uploads into the free service's temporary directory will not preserve them.
Back up Neon and the encryption key separately, and schedule the documented
cleanup task before public use. See [operations](OPERATIONS.md).

## External cron ping

Configure your external scheduler to send a GET request to:

```text
https://YOUR-SERVICE.onrender.com/api/cron/ping
```

No authorization or request body is required. Expect HTTP 200 and JSON containing
`success: true`, a random `requestId`, and the current `timestamp`. Responses use
`Cache-Control: no-store`. The handler does not query Neon, access R2, run queued
jobs, or call the AI provider. It is a liveness ping, not a database health check;
keep Render's deployment health check set to `/api/health`.

For testing, an external scheduler can call it every 5 minutes. No scheduler is
installed or enabled by adding this endpoint. A cron inside the same sleeping
process cannot wake it. Incoming traffic can wake a free Render service, but
free-service restarts and usage limits still apply; this does not guarantee
uninterrupted background processing. See [Render's free-service limits](https://render.com/docs/free).
The supplied Blueprint selects a free service and does not create a cron service.

If creating the service manually instead of using a Blueprint, leave **Root
Directory** blank, select the **Node** runtime and **Free** plan, and use:

```text
Build: npm --prefix backend ci && npm --prefix frontend ci --include=dev && npm --prefix frontend run build
Start: node backend/server/render-start.mjs
Health check: /api/health
```

Copy the non-secret environment settings from `render.yaml`, then enter the six
private values from step 2. Do not paste local development values over the Render
settings (particularly `HOST`, `DATA_DIR`, and `ADMIN_ORIGIN`).

## 5. Add Google Play credentials when ready

In Render **Environment → Secret Files**, create `google-play.json` and paste the
service-account JSON privately. Then set:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-play.json
PLAY_PACKAGE_NAME=ai.video.generator.image.generator
PLAY_RTDN_AUDIENCE=<the exact audience configured for your Pub/Sub push subscription>
PLAY_RTDN_SERVICE_ACCOUNT=<the Pub/Sub push authentication service-account email>
```

Complete the permissions, products, and notification setup in [Google Play setup](GOOGLE-PLAY.md)
before setting `PLAY_BILLING_ENABLED=1`. Payment-profile approval does not create
this JSON key for you.

Only when paid generation testing is authorized: configure `FAL_KEY`, review
queued/processing jobs and the dashboard integration settings, and set
`BACKGROUND_WORKERS_ENABLED=1`. This resumes both generation and periodic billing
reconciliation, including existing queued work. Do not enable it solely to check
hosting. Keep purchases disabled until their full verification flow is tested.

## Render references

- [Blueprint specification](https://render.com/docs/blueprint-spec)
- [Persistent disks and paid service requirement](https://render.com/docs/disks)
- [Environment variables and secret files](https://render.com/docs/configure-environment-variables)
- [Node.js version](https://render.com/docs/node-version)
