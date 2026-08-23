-- 056_add_sms_opt_outs.sql (defensive: handles pre-existing broken table)
-- Persistent opt-out store per (customer_phone, tenant_id).

CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES shops(tenant_id) ON DELETE CASCADE,
  customer_phone  text NOT NULL,
  opted_out_at    timestamptz NOT NULL DEFAULT now(),
  opted_out_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_opt_out_phone_tenant UNIQUE (tenant_id, customer_phone)
);

-- Add any missing columns (table was pre-created incomplete on remote)
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS customer_phone text;
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS opted_out_at timestamptz;
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS opted_out_reason text;
ALTER TABLE sms_opt_outs ADD COLUMN IF NOT EXISTS opted_back_at timestamptz;

-- Index for quick lookup before send (only if columns exist)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sms_opt_outs' AND column_name='tenant_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sms_opt_outs' AND column_name='customer_phone')
     AND EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='sms_opt_outs' AND column_name='opted_back_at')
  THEN
    CREATE INDEX IF NOT EXISTS idx_opt_outs_phone_tenant
      ON sms_opt_outs (tenant_id, customer_phone) WHERE opted_back_at IS NULL;
  END IF;
END $$;

-- RLS
ALTER TABLE sms_opt_outs ENABLE ROW LEVEL SECURITY;