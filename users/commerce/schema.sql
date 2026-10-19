CREATE TABLE orders (
  id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, key_cipher TEXT NOT NULL,
  email TEXT NOT NULL, plan TEXT NOT NULL, payment_intent TEXT NOT NULL,
  created INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX orders_payment ON orders(payment_intent);
CREATE TABLE deliveries (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), sent INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT
);
CREATE TABLE activations (
  order_id TEXT NOT NULL REFERENCES orders(id), device_hash TEXT NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY(order_id, device_hash)
);
CREATE TABLE revocations (payment_intent TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires INTEGER NOT NULL);
