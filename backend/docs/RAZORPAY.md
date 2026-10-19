# Razorpay billing setup

Genora's direct-distribution Android build uses Razorpay. Google Play Billing is not used by this build.

## 1. Create the recurring plan

In Razorpay Dashboard, enable Subscriptions and UPI AutoPay, then create one plan with these exact values:

- Name: `Genora Pro Weekly`
- Amount: `₹399.00` (`39900` paise)
- Period: `weekly`
- Interval: `1`
- Currency: `INR`

Copy the resulting plan ID (for example `plan_...`). The backend refuses to create a subscription if Razorpay reports a different amount, currency, interval, or period.

The backend creates each subscription with a ₹1 add-on charged during authorization and schedules the first ₹399 recurring debit one day later. Checkout clearly discloses that it auto-renews every seven days until cancelled.

## 2. Configure the webhook

In Razorpay Dashboard, open **Accounts & Settings → Webhooks**, create a webhook pointing to:

`https://YOUR-BACKEND/api/billing/webhooks/razorpay`

Generate a strong webhook secret and select these events:

- `payment.captured`
- `payment.refunded`
- `order.paid`
- `subscription.authenticated`
- `subscription.activated`
- `subscription.charged`
- `subscription.pending`
- `subscription.halted`
- `subscription.paused`
- `subscription.resumed`
- `subscription.cancelled`
- `subscription.completed`

The endpoint verifies `X-Razorpay-Signature` against the unmodified request body. Duplicate events are ignored.

## 3. Configure Render

Set these secret environment variables on the backend service:

```text
RAZORPAY_ENABLED=1
RAZORPAY_KEY_ID=rzp_test_...          # use rzp_live_... only after test sign-off
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
RAZORPAY_PLAN_ID=plan_...
RAZORPAY_INTRO_AMOUNT_PAISE=100
RAZORPAY_INTRO_DAYS=1
RAZORPAY_RENEWAL_AMOUNT_PAISE=39900
RAZORPAY_TOTAL_COUNT=520
```

Never place the key secret or webhook secret in the mobile app. The backend sends only the public key ID to checkout.

Run `npm --prefix backend run billing:setup` once against the production database to publish the three coin packs and weekly plan display. Back up the database first.

## 4. Test before live mode

1. Use Razorpay test credentials and a test plan.
2. Register a normal Genora user account.
3. Buy each coin pack and confirm each successful payment credits exactly once.
4. Retry verification and resend the webhook; the balance must not increase twice.
5. Start Pro and confirm the ₹1 charge, entitlement expiry, and subscription record.
6. Cancel in Genora and confirm Razorpay shows cancellation at cycle end.
7. Refund a coin payment and confirm coins are removed or recorded as refund debt.
8. Repeat with live credentials using the smallest real transactions, then issue refunds.

Only change `RAZORPAY_ENABLED` after all four live values belong to the same Razorpay mode. Test and live IDs must never be mixed.
