-- SprintAI Chat Platform — Initial Schema
-- Run this in Supabase SQL editor or via supabase db push

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TENANTS
-- ============================================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  phone_number TEXT, -- Twilio number assigned to this tenant
  website_url TEXT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT DEFAULT 'starter' CHECK (plan IN ('starter', 'pro', 'enterprise')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'onboarding')),
  config JSONB DEFAULT '{}',
  -- config fields: greeting, personality, business_type, address, hours, phone, email
  onboarding_status TEXT DEFAULT 'pending' CHECK (onboarding_status IN ('pending', 'scraping', 'embedding', 'complete', 'failed')),
  onboarding_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tenants_phone_number ON tenants(phone_number);
CREATE INDEX idx_tenants_stripe_customer_id ON tenants(stripe_customer_id);
CREATE INDEX idx_tenants_status ON tenants(status);

-- ============================================================
-- KNOWLEDGE BASE (with pgvector)
-- ============================================================
CREATE TABLE knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  source TEXT DEFAULT 'manual' CHECK (source IN ('website_scrape', 'manual', 'menu', 'faq', 'toast_menu')),
  metadata JSONB DEFAULT '{}',
  -- metadata: url, chunk_index, page_title, section, item_id (for menu items)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_knowledge_base_tenant_id ON knowledge_base(tenant_id);
-- IVFFlat index for vector similarity search
-- lists = 100 is good for up to 1M rows; adjust as needed
CREATE INDEX ON knowledge_base USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- CONVERSATIONS
-- ============================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'escalated')),
  metadata JSONB DEFAULT '{}'
  -- metadata: customer_name, order_in_progress, last_order_id, etc.
);

CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_customer_phone ON conversations(customer_phone);
CREATE INDEX idx_conversations_tenant_phone ON conversations(tenant_id, customer_phone);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'assistant', 'system')),
  content TEXT NOT NULL,
  tokens_used INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_tenant_id ON messages(tenant_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- ============================================================
-- INTEGRATIONS
-- ============================================================
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('toast', 'google_calendar', 'servicetitan', 'stripe', 'custom')),
  config JSONB NOT NULL DEFAULT '{}',
  -- config fields vary by type:
  -- toast: { restaurant_guid, client_id, client_secret, access_token, refresh_token, token_expires_at }
  -- google_calendar: { calendar_id, service_account_key }
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_integrations_tenant_type ON integrations(tenant_id, type);
CREATE INDEX idx_integrations_tenant_id ON integrations(tenant_id);

-- ============================================================
-- ORDERS (Toast integration)
-- ============================================================
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  toast_order_id TEXT,
  items JSONB NOT NULL DEFAULT '[]',
  -- items: [{ name, item_guid, quantity, price_cents, modifications }]
  total_cents INT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready', 'delivered', 'failed', 'cancelled')),
  customer_phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_tenant_id ON orders(tenant_id);
CREATE INDEX idx_orders_conversation_id ON orders(conversation_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_toast_order_id ON orders(toast_order_id);

-- ============================================================
-- USAGE TRACKING (for metered billing)
-- ============================================================
CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('sms_inbound', 'sms_outbound', 'ai_completion', 'embedding_generated', 'order_placed')),
  tokens_used INT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_usage_events_tenant_id ON usage_events(tenant_id);
CREATE INDEX idx_usage_events_type ON usage_events(event_type);
CREATE INDEX idx_usage_events_created ON usage_events(created_at DESC);

-- ============================================================
-- UPDATED_AT triggers
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_base_updated_at
  BEFORE UPDATE ON knowledge_base
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW-LEVEL SECURITY (RLS)
-- ============================================================
-- Enable RLS on all tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

-- Service role bypasses all RLS (for Edge Functions using service key)
-- No policies needed for service role — it bypasses RLS by default

-- Admin users (for dashboard) can see all tenants they own
-- We use a simple JWT claim: auth.jwt()->'user_metadata'->>'is_admin' = 'true'
-- OR auth.jwt()->'user_metadata'->>'tenant_id' = tenants.id::text (for tenant-scoped users)

-- Admin policy: full access for platform admins
CREATE POLICY "Admins have full access to tenants"
  ON tenants FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to knowledge_base"
  ON knowledge_base FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to conversations"
  ON conversations FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to messages"
  ON messages FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to integrations"
  ON integrations FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to orders"
  ON orders FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

CREATE POLICY "Admins have full access to usage_events"
  ON usage_events FOR ALL
  USING (
    auth.jwt()->'user_metadata'->>'is_admin' = 'true'
  );

-- Tenant-scoped user policies (for future tenant portal)
CREATE POLICY "Tenants can view their own data"
  ON tenants FOR SELECT
  USING (
    id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

CREATE POLICY "Tenants can view their own knowledge_base"
  ON knowledge_base FOR SELECT
  USING (
    tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

CREATE POLICY "Tenants can view their own conversations"
  ON conversations FOR SELECT
  USING (
    tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

CREATE POLICY "Tenants can view their own messages"
  ON messages FOR SELECT
  USING (
    tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

CREATE POLICY "Tenants can view their own orders"
  ON orders FOR SELECT
  USING (
    tenant_id::text = auth.jwt()->'user_metadata'->>'tenant_id'
  );

-- ============================================================
-- HELPER FUNCTION: vector search
-- ============================================================
CREATE OR REPLACE FUNCTION match_knowledge_base(
  query_embedding VECTOR(1536),
  match_tenant_id UUID,
  match_count INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.content,
    kb.source,
    kb.metadata,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE
    kb.tenant_id = match_tenant_id
    AND kb.embedding IS NOT NULL
    AND 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- ANALYTICS VIEWS
-- ============================================================
CREATE OR REPLACE VIEW tenant_stats AS
SELECT
  t.id AS tenant_id,
  t.name,
  t.plan,
  t.status,
  COUNT(DISTINCT c.id) AS total_conversations,
  COUNT(DISTINCT m.id) AS total_messages,
  COUNT(DISTINCT o.id) AS total_orders,
  MAX(c.last_message_at) AS last_activity,
  COUNT(DISTINCT kb.id) AS knowledge_base_entries
FROM tenants t
LEFT JOIN conversations c ON c.tenant_id = t.id
LEFT JOIN messages m ON m.tenant_id = t.id
LEFT JOIN orders o ON o.tenant_id = t.id
LEFT JOIN knowledge_base kb ON kb.tenant_id = t.id
GROUP BY t.id, t.name, t.plan, t.status;

-- Messages per day view
CREATE OR REPLACE VIEW messages_per_day AS
SELECT
  tenant_id,
  DATE_TRUNC('day', created_at) AS day,
  COUNT(*) AS message_count
FROM messages
WHERE role IN ('customer', 'assistant')
GROUP BY tenant_id, DATE_TRUNC('day', created_at)
ORDER BY day DESC;
