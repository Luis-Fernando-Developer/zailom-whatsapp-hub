-- ============================================================================
-- zailom-wa-service — schema inicial
-- ----------------------------------------------------------------------------
-- Rode este arquivo no Supabase externo (bcouunitysjtsjvwulnh) via
--    Dashboard > SQL Editor > New query
-- Tudo em uma transação. Idempotente (IF NOT EXISTS onde faz sentido).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- ENUMs
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.product_kind AS ENUM ('booking', 'flow', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.instance_status AS ENUM (
    'pending',      -- criado, ainda não pareado
    'connecting',   -- QR gerado / aguardando pareamento
    'connected',    -- online
    'disconnected', -- caiu / logout
    'deleted'       -- removido, mantido para auditoria
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.delivery_status AS ENUM ('pending', 'delivered', 'failed', 'dead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- tenants
-- Representa o "cliente" de cada produto Zailom.
-- (product, product_tenant_id) é único: Booking passa company_id, Flow passa workspace_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenants (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product            public.product_kind NOT NULL,
  product_tenant_id  TEXT NOT NULL,
  name               TEXT NOT NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product, product_tenant_id)
);

CREATE INDEX IF NOT EXISTS tenants_product_idx ON public.tenants (product);

-- ---------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------
-- key_prefix é a parte pública da key (indexável).
-- key_hash é argon2id do segredo completo.
-- scopes: ex. ['instances:read','messages:send','admin']
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  key_prefix     TEXT NOT NULL UNIQUE,
  key_hash       TEXT NOT NULL,
  scopes         TEXT[] NOT NULL DEFAULT ARRAY['instances:*','messages:*','chat:*','webhooks:*'],
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON public.api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON public.api_keys (tenant_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- instances
-- Representa uma instância Evolution vinculada a um tenant.
-- evolution_instance_name = identificador global usado na Evolution API
-- (formato: "{product}-{tenant.id}-{slugified(name)}") para evitar colisão.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instances (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  evolution_instance_name  TEXT NOT NULL UNIQUE,
  evolution_instance_id    TEXT,                          -- id retornado pela Evolution (se houver)
  evolution_token          TEXT,                          -- token específico da instância (Evolution "hash")
  status                   public.instance_status NOT NULL DEFAULT 'pending',
  connected_number         TEXT,                          -- E.164 sem +
  qr_code                  TEXT,                          -- base64 do último QR gerado
  pairing_code             TEXT,                          -- código alfanumérico (Evolution v2)
  qr_expires_at            TIMESTAMPTZ,
  webhook_url              TEXT,                          -- destino no tenant (Booking/Flow)
  webhook_events           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  webhook_by_events        BOOLEAN NOT NULL DEFAULT false,
  webhook_base64           BOOLEAN NOT NULL DEFAULT false,
  config                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS instances_tenant_idx ON public.instances (tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS instances_status_idx ON public.instances (status) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  actor          TEXT NOT NULL,                    -- 'api_key:<id>' | 'admin' | 'system'
  action         TEXT NOT NULL,                    -- 'instance.create', 'message.send', ...
  resource_type  TEXT,
  resource_id    TEXT,
  status_code    INT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx ON public.audit_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_time_idx ON public.audit_log (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- webhook_deliveries — outbound fan-out (Evolution -> tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  instance_id    UUID REFERENCES public.instances(id) ON DELETE SET NULL,
  event_type     TEXT NOT NULL,
  target_url     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  signature      TEXT NOT NULL,                    -- HMAC-SHA256 hex do payload
  status         public.delivery_status NOT NULL DEFAULT 'pending',
  attempt        INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 6,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INT,
  last_error     TEXT,
  delivered_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wd_pending_idx
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS wd_tenant_time_idx
  ON public.webhook_deliveries (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_tenants_updated ON public.tenants;
CREATE TRIGGER trg_tenants_updated  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_instances_updated ON public.instances;
CREATE TRIGGER trg_instances_updated BEFORE UPDATE ON public.instances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_wd_updated ON public.webhook_deliveries;
CREATE TRIGGER trg_wd_updated BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS (defesa em profundidade)
-- O serviço acessa via connection string do Postgres (owner/service), então
-- RLS não é aplicada a ele. Mesmo assim ativamos e revogamos qualquer acesso
-- dos roles anon/authenticated para bloquear a Data API pública se alguém
-- tentar consumir esse projeto Supabase por engano.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instances           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenants             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.instances           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries  FORCE ROW LEVEL SECURITY;

-- Revoga qualquer default grant para anon/authenticated (não confiar em ninguém).
REVOKE ALL ON public.tenants,
             public.api_keys,
             public.instances,
             public.audit_log,
             public.webhook_deliveries
  FROM anon, authenticated;

-- service_role bypassa RLS por padrão, mas garantimos GRANT para o caso do
-- serviço acessar via PostgREST (não é o padrão, mas mantém a porta aberta).
GRANT ALL ON public.tenants,
             public.api_keys,
             public.instances,
             public.audit_log,
             public.webhook_deliveries
  TO service_role;

COMMIT;