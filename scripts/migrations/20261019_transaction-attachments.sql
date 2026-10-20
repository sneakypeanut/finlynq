-- Receipts & invoices attached to a single transaction.
--
-- Files are stored OUTSIDE the app bundle under the durable uploads root
-- (<uploads>/receipts/<user_id>/<uuid>.<ext>) and are AES-256-GCM
-- encrypted at rest with the OWNER's DEK (lib/crypto/file-envelope.ts).
-- `filename_enc` is the DEK-encrypted original filename (lib/crypto/envelope.ts
-- `encryptField`), because a receipt filename leaks the merchant.
--
-- `sha256` is the hash of the PLAINTEXT bytes, so a re-run of the receipt
-- sweep can dedupe against what is already attached without decrypting.
--
-- `source` records provenance: 'upload' (the transaction dialog) or 'email'
-- (the Gmail receipt sweep). `source_ref` holds the Gmail thread id.
CREATE TABLE IF NOT EXISTS "transaction_attachments" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "transaction_id" integer NOT NULL,
  "storage_path" text NOT NULL,
  "filename_enc" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "source" text DEFAULT 'upload' NOT NULL,
  "source_ref" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "transaction_attachments"
  ADD CONSTRAINT "transaction_attachments_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "transaction_attachments"
  ADD CONSTRAINT "transaction_attachments_transaction_id_transactions_id_fk"
  FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "transaction_attachments"
  ADD CONSTRAINT "transaction_attachments_source_check"
  CHECK ("source" IN ('upload','email'));

-- Serve / list a transaction's receipts.
CREATE INDEX IF NOT EXISTS "idx_transaction_attachments_tx"
  ON "transaction_attachments" ("transaction_id");

-- Dedupe a re-imported receipt against what is already attached.
CREATE INDEX IF NOT EXISTS "idx_transaction_attachments_user_hash"
  ON "transaction_attachments" ("user_id", "sha256");
