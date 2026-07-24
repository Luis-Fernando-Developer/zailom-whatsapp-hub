-- Add 'qrcode' value to instance_status enum so refresh-status can persist it.
DO $$ BEGIN
  ALTER TYPE public.instance_status ADD VALUE IF NOT EXISTS 'qrcode' BEFORE 'connected';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;