# fal.ai generation

Set `FAL_KEY` in the backend environment, then run `npm run fal:setup` while the
backend has no active jobs. Restart the backend after changing the key. Setup
enables the recommended production presets in the configured database; it makes no paid
generation requests. The dashboard's Integrations page lets the administrator choose
the generation model, editing model, output shape, and pause new generations. Keys stay in the environment, never in
the frontend, mobile bundle, database job snapshots, or logs.

## Models and output settings

| Request/model          | Endpoint                                           | Output behavior                              | Indicative cost |
| ---------------------- | -------------------------------------------------- | -------------------------------------------- | --------------- |
| Recommended image      | fal-ai/flux-2-pro                                  | Admin-selected aspect ratio, PNG             | $0.03 first output MP; $0.015/additional MP |
| Balanced image         | fal-ai/flux-2/klein/9b/base                        | Admin-selected aspect ratio, 32 steps, PNG   | $0.011/output MP |
| Economy image          | fal-ai/flux/schnell                                | Admin-selected aspect ratio, 4 steps, PNG    | $0.003/output MP |
| Recommended edit       | fal-ai/flux-pro/kontext                            | One source; nearest source aspect ratio; PNG | $0.04/image |
| Maximum edit           | fal-ai/flux-pro/kontext/max                        | One source; nearest source aspect ratio; PNG | $0.08/image |
| Balanced edit          | fal-ai/flux-2/klein/9b/base/edit                   | One source; provider uses source dimensions  | $0.011/input and output MP |
| Image to video / dance | fal-ai/longcat-video/distilled/image-to-video/720p | 162 frames, 30 fps, 720p H.264 MP4           | Check current provider price |
| Text to video          | fal-ai/longcat-video/distilled/text-to-video/720p  | Same video preset, portrait format           | Check current provider price |

Image rates were checked against fal's official model pages on 2026-09-23. Video billing
uses 30 frames per second, so 162 frames request a 5.4-second clip. Provider output can differ from the requested duration or resolution; these are request settings, not hard billing caps. Image dimensions
follow the administrator's selected output shape; photo edits follow the source aspect ratio instead of forcing a square.
Input editing may be billed separately. Actual charges are controlled by fal and may
change; these estimates are not a billing guarantee. Prompt expansion is disabled,
one output is requested. Generation and editing prompts are expanded on the server
with composition, lighting, material, anatomy, identity, and bounded-edit constraints.
No automatic paid upscaling, audio generation, or multi-stage enhancement is performed.
Only administrators can select models; mobile clients cannot select them.
Text-to-image and photo editing are separate selections. FLUX.1 Schnell is used only
when the request has no uploaded photo. A request with an uploaded photo uses the selected
editing endpoint instead: about $0.022 for a 1 MP Klein input plus 1 MP output, $0.04 for
Kontext Pro, or $0.08 for Kontext Max. The dashboard labels both selectors and each rate
separately so an editing charge is not mistaken for a Schnell charge.

Dance uses prompt-guided image animation, not reference-video choreography transfer.
Slideshow generation remains unavailable for this integration. The app receives
accurate service flags through `/api/config`.

## Upload and result flow

1. The signed-in app uploads the original PNG/JPEG/WebP bytes to `/api/uploads`, without resizing or recompressing. Unsupported phone formats are converted to maximum-quality JPEG only when required.
2. The backend saves it to private R2 and stores ownership and an object reference
   in Neon. It returns an upload ID and an authenticated app URL.
3. The app submits the upload ID and prompt to `/api/jobs` with an idempotency key.
   The backend verifies ownership and reserves the configured app coins.
4. The worker creates a signed R2 GET URL, valid for four hours, and sends it in
   fal's `image_url` or `image_urls` field. The fal queue start deadline is one hour.
   No base64 image or R2 credential is sent to fal. Keep the bucket private.
5. fal's request ID and queue URLs are saved in `fal_requests`. The worker polls
   that request, allowing the app to close while work continues.
6. Completed output is downloaded with size, type, HTTPS and public-DNS checks,
   then uploaded to R2. The job succeeds only after storage succeeds.
7. App job responses return fresh, temporary R2 result links after checking
   ownership. The app refreshes the job before saving or sharing the result.

App uploads and provider requests go through the backend. Native apps do not need
R2 CORS configuration. For browser playback, see the GET/HEAD CORS guidance in
[R2.md](R2.md). No publicly reachable webhook server is required: polling works
from local development too.

## Retries and costs

At most two jobs can be unfinished across the app when accepting a fal job.
Repeated mobile submissions with the same idempotency key return the original job.
An R2 output-copy retry reuses the completed provider result.

fal does not document a submission idempotency guarantee. Before the paid POST,
the worker commits a submission marker. If the process crashes or the response is
lost before its request ID is saved, the worker does not submit again. The app job
fails and its coins are refunded; a possibly accepted fal request can still be
billed. The administrator can investigate that request in fal's dashboard.
Confirmed queue IDs are reused across restarts. Transient polling failures retry;
authentication/validation failures stop. Provider response bodies and credentials
are excluded from application errors and logs. `X-Fal-No-Retry: 1` also disables
provider-side retries for submissions.

App coins and fal dollars are separate balances. Existing app costs and rewards
are preserved. Use the dashboard's user coin adjustment for a test account that
needs app coins. A fal credit purchase does not add app coins automatically.

Run one backend worker instance. Multi-instance worker leasing is not implemented.

## Verification

`npm test` uses simulated fal/R2 and temporary databases; it does not load `.env`
or spend credits. For PostgreSQL tests, use a dedicated `TEST_POSTGRES_URL`.

The following explicit live check makes paid provider requests; review current fal pricing first:

```sh
npm run fal:smoke -- --confirm-paid-test
```

It generates one image, edits that image, and animates it into a video through the
same upload/job APIs. It uses an isolated local test database/wallet, downloads the
R2 outputs into `data/verification/`, checks signed access, and removes temporary
R2 test objects on success. No real account balances are changed. On failure it
keeps diagnostic job state and does not automatically resubmit. Re-running the
command starts a new paid test; investigate a failed run before doing so.

References: [keys](https://fal.ai/docs/documentation/setting-up/authentication),
[queue API](https://fal.ai/docs/documentation/model-apis/inference/queue),
[Schnell](https://fal.ai/models/fal-ai/flux/schnell),
[FLUX.2 Pro](https://fal.ai/models/fal-ai/flux-2-pro),
[Klein 9B](https://fal.ai/models/fal-ai/flux-2/klein/9b/base),
[Klein 9B edit](https://fal.ai/models/fal-ai/flux-2/klein/9b/base/edit),
[Kontext Pro](https://fal.ai/models/fal-ai/flux-pro/kontext),
[Kontext Max](https://fal.ai/models/fal-ai/flux-pro/kontext/max),
[LongCat image-to-video](https://fal.ai/models/fal-ai/longcat-video/distilled/image-to-video/720p),
[LongCat text-to-video](https://fal.ai/models/fal-ai/longcat-video/distilled/text-to-video/720p).

## Live verification note

The initial live verification completed one text image, one photo edit, and one
image-to-video request. R2 input URLs, output copies, signed downloads and H.264
decoding passed. The video returned 960 × 960 at 30 fps with an 11.67-second
duration despite the requested 162 frames. The $0.075 pre-run estimate is therefore
not a verified charge; consult fal billing for the actual spend. Further paid
tests were stopped at the user’s request. Use only offline tests unless a new
paid test is explicitly authorized.
