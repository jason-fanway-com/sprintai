const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://fdxvflryvctvstxdbdtm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkeHZmbHJ5dmN0dnN0eGRiZHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTEyNDcyMSwiZXhwIjoyMDg2NzAwNzIxfQ.wHeUtOUz28kL1pLafERmuByxqYTtK0H9jDE3t0GDclI'
);

const SQL = `
CREATE TABLE IF NOT EXISTS crm_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, website TEXT, phone TEXT, city TEXT, state TEXT, zip TEXT,
  google_rating NUMERIC(2,1), google_reviews INTEGER, google_maps_url TEXT,
  industry TEXT DEFAULT 'HVAC', employee_count TEXT, annual_revenue TEXT,
  notes TEXT, tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'prospect' CHECK (status IN ('prospect','contacted','qualified','customer','churned','dead')),
  source TEXT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  first_name TEXT, last_name TEXT, full_name TEXT, email TEXT,
  email_type TEXT CHECK (email_type IN ('personal','role_based','unknown')),
  email_verified BOOLEAN DEFAULT false, zerobounce_status TEXT,
  phone TEXT, phone_source TEXT, title TEXT, is_owner BOOLEAN DEFAULT false,
  linkedin_url TEXT, notes TEXT, tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'new' CHECK (status IN ('new','contacted','replied','qualified','customer','unsubscribed','bounced')),
  last_contacted_at TIMESTAMPTZ, outreach_channel TEXT, campaign_id TEXT, source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES crm_companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('email_sent','email_received','call_made','call_received','sms_sent','sms_received','note','meeting','status_change')),
  subject TEXT, body TEXT, outcome TEXT, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  name TEXT NOT NULL, value NUMERIC(10,2), monthly_value NUMERIC(10,2),
  stage TEXT DEFAULT 'lead' CHECK (stage IN ('lead','contacted','demo_scheduled','proposal_sent','negotiation','closed_won','closed_lost')),
  tier TEXT, close_date DATE, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON crm_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_is_owner ON crm_contacts(is_owner);
CREATE INDEX IF NOT EXISTS idx_companies_status ON crm_companies(status);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON crm_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_company ON crm_activities(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON crm_deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_company ON crm_deals(company_id);

ALTER TABLE crm_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all' AND tablename = 'crm_companies') THEN
    CREATE POLICY "service_role_all" ON crm_companies FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all' AND tablename = 'crm_contacts') THEN
    CREATE POLICY "service_role_all" ON crm_contacts FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all' AND tablename = 'crm_activities') THEN
    CREATE POLICY "service_role_all" ON crm_activities FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all' AND tablename = 'crm_deals') THEN
    CREATE POLICY "service_role_all" ON crm_deals FOR ALL USING (true);
  END IF;
END $$;
`;

exports.handler = async () => {
  try {
    const { error } = await supabase.rpc('exec_sql', { sql: SQL });
    if (error) {
      // rpc may not exist — fallback: just report
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'SQL ready to run. If exec_sql RPC is not set up, paste the SQL into the Supabase SQL editor.',
          sql: SQL,
          rpc_error: error.message,
        }),
      };
    }
    return { statusCode: 200, body: JSON.stringify({ message: 'Database tables created successfully.' }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
