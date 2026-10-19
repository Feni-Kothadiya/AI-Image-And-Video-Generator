CREATE TABLE IF NOT EXISTS razorpay_orders(
  order_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  product_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  currency TEXT NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),
  payment_id TEXT UNIQUE,
  status TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 0 CHECK(granted>=0),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS razorpay_orders_user ON razorpay_orders(user_id,created_at);

CREATE TABLE IF NOT EXISTS razorpay_subscriptions(
  subscription_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  auth_payment_id TEXT UNIQUE,
  start_at BIGINT NOT NULL DEFAULT 0,
  current_start BIGINT NOT NULL DEFAULT 0,
  current_end BIGINT NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL DEFAULT 0,
  verified_at BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS razorpay_subscriptions_user ON razorpay_subscriptions(user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS razorpay_subscription_payments(
  payment_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES razorpay_subscriptions(subscription_id) ON DELETE CASCADE,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS razorpay_events(
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL);
