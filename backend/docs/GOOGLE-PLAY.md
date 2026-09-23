# Google Play purchases

Android uses Google Play Billing through `expo-iap`; the backend verifies purchases
with the Google Play Developer API. No RevenueCat account is needed.

Premium grants **unlimited AI creation, premium templates, and ad-free use** while a
weekly or yearly subscription is active. Coin packs remain separate consumable purchases.
The app creates an automatic installation wallet, so users can purchase without signing in.

## 1. Create the products in Play Console

Use package `ai.genora.image.video.editor` for the Play Console app and build.
Complete the Play Console account/payment profile setup and upload a signed Android
App Bundle to an internal testing track. The native billing module requires a new build;
an old APK or Expo Go cannot test these purchases.

Under your app's **Monetize with Play → Products**, create and activate:

| Type | Product ID | Base plan ID | Benefit |
| --- | --- | --- | --- |
| One-time consumable | `ai_creator_coins_50` | — | 50 coins |
| One-time consumable | `ai_creator_coins_150` | — | 150 coins |
| One-time consumable | `ai_creator_coins_500` | — | 500 coins |
| Auto-renewing subscription | `ai_creator_premium_weekly` | `weekly` | Premium, billed weekly |
| Auto-renewing subscription | `ai_creator_premium_yearly` | `yearly` | Premium, billed yearly |

Create one standard buy option for each coin pack and one auto-renewing base plan for
each subscription. Set the base plan's actual billing period in Play Console. This first
implementation selects regular base plans only; do not rely on trial, prepaid, installment,
or promotional-offer behavior. Create a new product ID if changing a coin pack's coin amount.

Set regional availability, prices, and descriptions in Play Console. The app shows
localized prices and subscription periods returned by Google Play; admin price labels
do not override checkout prices. Existing preview prices are not automatically configured
in Google Play.

Admin → Economy allows editing product IDs and subscription base plan IDs. Admin →
Templates has a Premium toggle. Initial premium examples are Neon nights (`p1`), Studio
rhythm (`v2`), and City diary (`s1`). Other templates remain accessible without premium.

## 2. Configure the backend service account

1. Create/select a Google Cloud project and enable **Google Play Android Developer API**.
2. Create a service account for purchase verification.
3. Play Console → **Users and permissions → Invite new users**: add that service account's
   email, grant access to this app, and grant the billing permissions to view financial
   data/orders and manage orders/subscriptions.
4. Create/download its JSON key and store it on the backend at
   `backend/data/google-play-service-account.json` (or use your hosting secret-file facility).
   The file stays on the backend; never include it in the app or an `EXPO_PUBLIC_` variable.
5. Set these variables in the backend environment. Keep billing disabled until products,
   notification delivery, and license testers are configured:

```dotenv
PLAY_BILLING_ENABLED=0
PLAY_PACKAGE_NAME=ai.genora.image.video.editor
GOOGLE_APPLICATION_CREDENTIALS=/absolute/backend/data/google-play-service-account.json
PLAY_RTDN_AUDIENCE=https://YOUR_BACKEND/api/billing/notifications
PLAY_RTDN_SERVICE_ACCOUNT=play-push@YOUR_PROJECT.iam.gserviceaccount.com
```

The Google Cloud project ID and service-account emails are configuration identifiers.
The JSON key is the secret. No Google Play private key belongs in the mobile app.

## 3. Connect real-time billing notifications

1. Enable Pub/Sub in the Cloud project and create a topic, such as `play-billing`.
2. Grant `google-play-developer-notifications@system.gserviceaccount.com` the **Pub/Sub
   Publisher** role on that topic.
3. Create an authenticated **push subscription**, with endpoint
   `https://YOUR_BACKEND/api/billing/notifications` and a dedicated push-auth service account.
4. Set its OIDC audience to that exact URL. Put the same audience and push service-account
   email in `PLAY_RTDN_AUDIENCE` and `PLAY_RTDN_SERVICE_ACCOUNT`.
5. Configure the Pub/Sub service agent's token-creation permission as described in Google's
   authenticated-push guide below. This lets Pub/Sub issue its signed delivery identity.
6. In Play Console's monetization setup, set the full topic name
   `projects/YOUR_PROJECT/topics/play-billing`, enable notifications for subscriptions and
   one-time products, and send a test notification. A successful delivery returns HTTP 204.

The backend verifies the signed Google identity, audience, service-account email, and
package name. Notification payloads are only triggers: purchase status is fetched from
Google before applying changes. Configure delivery retries/dead-letter monitoring.

## 4. Enable sandbox testing

1. Add the tester's Google account under Play Console **Settings → License testing** and
   to the app's internal testing list. Use that same account in the Play Store on the device.
2. Configure the app's `EXPO_PUBLIC_API_URL` to your reachable HTTPS backend before building.
3. Build a new signed Android App Bundle using the existing production EAS profile and
   upload it to internal testing. Install through the internal testing opt-in link.
4. If installing on a new database, run `npm run billing:setup` from `backend/` to apply
   tables, suggested product IDs, and sample premium flags. It backs up published/draft
   content separately and does not call Google Play or an AI provider.
5. Once setup is complete, set `PLAY_BILLING_ENABLED=1` and restart the backend.
6. Open the app and wait for its automatic wallet to connect. Purchase dialogs for
   correctly configured license testers offer Google test payment methods. Use those test
   methods; do not use a real card.

Keep AI generation disabled during purchase testing to avoid spending fal.ai credits.
Billing verification tests do not need image/video generation.

## Test checklist

- Buy each coin pack; verify the server wallet increases by the exact amount once.
- Retry verification/Restore after a network interruption; no duplicate credit.
- Cancel checkout; verify no coins/premium are granted.
- Use a pending test payment; verify access remains locked until confirmation.
- Buy weekly/yearly premium; PRO templates unlock, ad prompts disappear, and AI jobs cost zero coins.
- Confirm premium image/video jobs leave the wallet balance unchanged.
- Cancel auto-renewal; retain access through the paid expiry. Test expiry, hold, and recovery.
- Refund a pack; unspent coins are removed. Spent refunded coins become a balance to settle,
  blocking generation until repaid. Repeated refund notifications do not deduct twice.
- Restore on reinstall with the same app account. A different app account cannot claim it.
- Verify notifications arrive while the app is closed and subscription renewals update expiry.

## Operations and limits

`GET /api/billing/catalog` returns purchasable products, the obfuscated account ID,
premium status, and any refunded coin debt. `POST /api/billing/verify` accepts only
`productId` and `token`; the client cannot choose a coin amount or expiry.

Purchase tokens are encrypted with `data/master.key`, hashed for deduplication, and
excluded from admin purchase responses. Keep the existing master-key backup with the
database backup. Restore of consumed coin packs means restoring the server wallet,
not granting those packs again.

The backend acknowledges subscriptions and consumes coin packs after the durable grant.
Its billing reconciliation timer retries unfinished transactions and refreshes stored
purchases. Real-time notifications should be the primary update mechanism. A premium
snapshot older than 15 minutes fails closed until successfully reverified. Subscription
plan switches are handled through Google Play management; the app prevents buying a
second subscription while an active one is already known.

Ad delivery itself is not installed in this app yet. The premium entitlement marks users
ad-free and hides rewarded-ad prompts; any future ad renderer must also honor `adFree`.
This implementation does not enable advertisements or call fal.ai.

## Official references

- [Expo in-app purchases and native builds](https://docs.expo.dev/guides/in-app-purchases/)
- [Google service-account setup and permissions](https://developers.google.com/android-publisher/getting_started)
- [Verify purchases and acknowledge on the backend](https://developer.android.com/google/play/billing/security)
- [Google Play test purchases](https://developer.android.com/google/play/billing/test)
- [Real-time developer notifications](https://developer.android.com/google/play/billing/rtdn-reference)
- [Pub/Sub authenticated push](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions)
