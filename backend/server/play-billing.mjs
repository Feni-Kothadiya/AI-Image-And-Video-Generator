import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { fail } from "./schema.mjs";

export function createPlayBilling({ env = process.env } = {}) {
  const packageName =
    env.PLAY_PACKAGE_NAME || "ai.genora.image.video.editor";
  const enabled =
    env.PLAY_BILLING_ENABLED === "1" && !!(env.GOOGLE_APPLICATION_CREDENTIALS && env.PLAY_RTDN_AUDIENCE && env.PLAY_RTDN_SERVICE_ACCOUNT);
  const auth = new GoogleAuth({
    keyFile: env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const identity = new OAuth2Client();
  const root =
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
    encodeURIComponent(packageName);
  async function request(path, method = "GET") {
    if (!enabled) fail(503, "Google Play billing is not configured yet.");
    try {
      const client = await auth.getClient();
      const response = await client.request({
        url: root + path,
        method,
        ...(method === "POST" ? { data: {} } : {}),
        timeout: 15000,
      });
      return response.data;
    } catch (e) {
      if ([400, 404, 410].includes(e.response?.status))
        fail(400, "Google Play could not verify this purchase.");
      fail(
        503,
        "Google Play verification is temporarily unavailable. Your purchase can be restored later.",
      );
    }
  }
  return {
    enabled,
    packageName,
    notificationsReady: !!(
      env.PLAY_RTDN_AUDIENCE && env.PLAY_RTDN_SERVICE_ACCOUNT
    ),
    get: (kind, token) =>
      request(
        `/purchases/${kind === "subscription" ? "subscriptionsv2" : "productsv2"}/tokens/${encodeURIComponent(token)}`,
      ),
    consume: (product, token) =>
      request(
        `/purchases/products/${encodeURIComponent(product)}/tokens/${encodeURIComponent(token)}:consume`,
        "POST",
      ),
    acknowledge: (product, token) =>
      request(
        `/purchases/subscriptions/${encodeURIComponent(product)}/tokens/${encodeURIComponent(token)}:acknowledge`,
        "POST",
      ),
    async authenticateNotification(header) {
      if (!env.PLAY_RTDN_AUDIENCE || !env.PLAY_RTDN_SERVICE_ACCOUNT)
        fail(503, "Billing notifications are not configured.");
      if (
        typeof header !== "string" ||
        !header.startsWith("Bearer ") ||
        header.length > 8192
      )
        fail(401, "Invalid notification identity.");
      try {
        const ticket = await identity.verifyIdToken({
          idToken: header.slice(7),
          audience: env.PLAY_RTDN_AUDIENCE,
        });
        const claims = ticket.getPayload();
        if (
          claims?.email !== env.PLAY_RTDN_SERVICE_ACCOUNT ||
          !claims.email_verified
        )
          throw new Error();
      } catch {
        fail(401, "Invalid notification identity.");
      }
    },
  };
}
