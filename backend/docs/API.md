# Backend API and provider contract

Base URL: http://localhost:4000 locally. All production traffic must use HTTPS.
JSON requests use Content-Type: application/json. Errors return { "error": "message" }.
Validation failures are 400, unauthenticated 401, forbidden 403, missing resources 404,
state conflicts 409, rate limits 429, and unconfigured services 503.

## App routes

| Method     | Route                | Behavior                                                           |
| ---------- | -------------------- | ------------------------------------------------------------------ |
| GET        | /api/health          | Database liveness                                                  |
| GET        | /api/config          | Published content, version, service availability, UTC serverDate   |
| POST       | /api/auth/guest      | Create installation account and opaque bearer session              |
| POST       | /api/auth/register   | Attach email/password to current guest; preserves its wallet       |
| POST       | /api/auth/login      | Return user and bearer session                                     |
| POST       | /api/auth/logout     | Revoke current session                                             |
| GET        | /api/me              | Profile, wallet, UTC serverDate                                    |
| POST       | /api/me/password     | currentPassword, newPassword; revoke other sessions                |
| DELETE     | /api/me              | confirmation: DELETE and password for registered accounts          |
| GET        | /api/wallet          | Balance and latest 100 ledger entries                              |
| POST       | /api/rewards/daily   | Atomic once-per-UTC-day claim                                      |
| POST       | /api/uploads         | Authenticated multipart file, PNG/JPEG/WebP, maximum 10 MB         |
| GET/DELETE | /api/uploads/:id     | Owner-only private input image access/deletion                     |
| POST       | /api/jobs            | Reserve coins and enqueue work; requires Idempotency-Key           |
| GET        | /api/jobs            | Latest 100 generations belonging to the current account            |
| GET        | /api/jobs/:id        | Current account's generation status/result                         |
| POST       | /api/jobs/:id/cancel | Cancel queued work and refund; processing jobs cannot be cancelled |
| POST       | /api/reports         | reason, optional templateId and detail                             |
| POST       | /api/billing/verify  | Disabled until Google Play verification is implemented             |
| POST       | /api/rewards/ad      | Disabled until verified ad callbacks are implemented               |

Except health, config, guest, and login, app routes require Authorization: Bearer TOKEN.
Sessions expire after 30 days. Passwords must contain 12–128 characters.
Email addresses currently identify accounts; they are not yet verified through an email provider.

Create-job body:

    {
      "mode": "image",
      "prompt": "An editorial portrait in soft light",
      "templateId": "p0",
      "uploadIds": ["a-photo-uuid"],
      "background": "Original"
    }

Mode is image, video, dance, or slideshow. Template-based jobs and dance require a photo.
Slideshows must match the published template's photo count. Generation costs and rewards
come from the server's published configuration, not from the request.
At most three unfinished jobs per user are accepted.
The fal integration additionally limits the app to two unfinished jobs, supports
image/video/dance, and reports slideshow as unavailable. See [fal integration](FAL.md).
Input photos total at most 30 MB; user media quota is approximately 200 MB.

An identical Idempotency-Key and identical body return the original job.
Reusing the key with different input returns 409. Keep the same key after a network timeout.
Jobs can be queued, processing, succeeded, failed, or cancelled. Reserved coins are refunded
once on failure/cancellation; completion rewards are credited once on success.

## Admin routes

Admin login uses POST /api/admin/login with email/password. It sets an HttpOnly,
SameSite=Strict cookie scoped to /api/admin and returns a CSRF token.
Every admin mutation needs the configured Origin and X-CSRF-Token.
Production cookies also require Secure. Sessions expire after 12 hours.

| Route under /api/admin | Methods / payload                                                    |
| ---------------------- | -------------------------------------------------------------------- |
| /session, /logout      | GET session; POST logout                                             |
| /password              | POST currentPassword/newPassword                                     |
| /overview              | GET counts, activity, service readiness                              |
| /content               | GET draft/published; PUT {version,content}                           |
| /content/publish       | POST {version,note}                                                  |
| /revisions             | GET release history                                                  |
| /revisions/:id/restore | POST {version}; updates the draft only                               |
| /users                 | GET ?q=&page=; 30 records/page                                       |
| /users/:id             | GET details; PATCH {status}; DELETE {confirmation:"DELETE"}          |
| /users/:id/coins       | POST {amount,reason,requestId}; requestId is UUID and idempotent     |
| /jobs                  | GET ?q=&page=; search IDs, user IDs, or statuses                     |
| /jobs/:id/cancel       | POST; queued jobs only                                               |
| /reports               | GET latest 200 reports                                               |
| /reports/:id           | PATCH {status:"open"                                                 | "reviewing" | "resolved"} |
| /media                 | GET public assets; POST multipart file                               |
| /media/:id             | DELETE unused asset; published revision references protect old media |
| /integration           | GET redacted configuration; PUT {settings,apiKey?,removeKey?}        |
| /audit                 | GET ?page=; 50 entries/page                                          |
| /purchases             | GET; reports configured:false until billing is integrated            |

Public uploaded artwork is served at /media/:filename. Private inputs never use this route.

## Direct fal.ai adapter

The `fal` provider uses `server/fal.mjs` to submit and poll fal queue requests with
`Authorization: Key FAL_KEY`. Input photos use four-hour signed R2 GET URLs. Output
objects are copied into R2 before completion. Models and output limits are fixed
by the backend; see [FAL.md](FAL.md). The admin integration response contains only
key presence, model settings and service readiness. The key remains in the server
environment. `fal_requests` stores durable submission/queue state for restart safety.

## Custom AI gateway adapter

The optional custom gateway uses server/gateway.mjs. The direct fal integration
does not require this separate gateway service. Automated tests inject isolated
adapters and never call an actual provider.

Allowed connections:

- HTTPS port 443 only, no user/password/query/fragment in gateway base URL.
- Exact gateway hostname must appear in AI_ALLOWED_HOSTS.
- Public IPv4 DNS results only, with the resolved address pinned to the HTTPS request.
- No HTTP redirects. No browser/client control over gateway destinations.
- Authorization: Bearer SECRET and Idempotency-Key: INTERNAL_JOB_UUID.

### POST {gatewayUrl}/jobs

    {
      "clientJobId": "internal-job-uuid",
      "model": "provider-model-or-route",
      "mode": "image",
      "prompt": "...",
      "templateId": "p0",
      "background": "Original",
      "images": [{"mimeType":"image/jpeg","data":"BASE64_BYTES"}],
      "duration": 15
    }

The gateway MUST persist and honor Idempotency-Key/clientJobId. A worker can retry
the create request after a crash or timeout. This requirement prevents duplicate provider charges.
Do not enable a gateway that does not support it.

Immediate completion:

    {"status":"succeeded","resultUrl":"https://media.example.com/result.jpg"}

Asynchronous acceptance:

    {"status":"processing","id":"provider-job-id"}

### GET {gatewayUrl}/jobs/{providerJobId}

    {"status":"processing","id":"provider-job-id"}
    {"status":"succeeded","resultUrl":"https://media.example.com/result.mp4"}
    {"status":"failed"}

Responses must be JSON under 1 MB. Network requests time out after 30 seconds.
Transient failures retry up to five attempts with backoff. Pending work times out after
two hours and is refunded. An explicit failed result refunds immediately.
Raw provider error bodies are not exposed to users or logs.

Return a downloadable HTTPS image/video URL. With R2 configured, the worker copies
the provider output to the private bucket before marking the job successful. The
job API returns a fresh signed resultUrl and resultMime after ownership checks;
expiring URLs are never persisted as permanent R2 object references. PNG, JPEG,
WebP images and MP4 video results are supported. Without R2, legacy behavior stores
the provider URL only. See R2.md for configuration, size limits, and migration.

### Operational constraints

Run one backend/worker process. DATABASE_URL selects PostgreSQL; otherwise the backend
uses local SQLite. Transactions serialize wallet and publishing changes on one
database connection. The current worker dispatcher is not designed for multiple
replicas; add atomic leased job claims before scaling workers horizontally.
