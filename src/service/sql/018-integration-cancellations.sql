-- Durable cancellation intent is distinct from transport delivery and native termination.
CREATE TABLE birbcrew_ts.integration_cancellations (
  conversation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  receipt_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  PRIMARY KEY(conversation_id,request_id),
  FOREIGN KEY(conversation_id,request_id) REFERENCES birbcrew_ts.request_admissions
);
