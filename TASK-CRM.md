# TASK: Build SprintAI CRM Admin Panel

## Context
This is a static HTML site (getsprintai.com) using Tailwind CDN, no build step, deployed on Netlify. The CRM lives at `/admin/` as a new section. It uses Supabase for data storage.

## Supabase Config
- **URL:** `https://fdxvflryvctvstxdbdtm.supabase.co`
- **Anon Key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkeHZmbHJ5dmN0dnN0eGRiZHRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExMjQ3MjEsImV4cCI6MjA4NjcwMDcyMX0.wn80dndvXLUU6qMzJW1DBuz0d6cPMu4iEO3UA6QnF4E`
- **Service Role Key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkeHZmbHJ5dmN0dnN0eGRiZHRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTEyNDcyMSwiZXhwIjoyMDg2NzAwNzIxfQ.wHeUtOUz28kL1pLafERmuByxqYTtK0H9jDE3t0GDclI`

Use the SERVICE ROLE KEY in the admin page (it's password-protected anyway). This avoids RLS issues.

## Architecture
- **No build step.** Plain HTML + Tailwind CDN + Supabase JS CDN.
- **No React.** Vanilla JS with DOM manipulation.
- **Auth:** Simple password gate (hardcoded: password = `sprint2026!`). Store in localStorage after login. No Supabase auth.
- **Style:** Match the existing site — indigo-600 primary, clean cards, Tailwind utility classes.

## Database Schema (create via Supabase SQL)

Create a Netlify function at `netlify/functions/setup-db.js` that creates these tables when hit (idempotent — use IF NOT EXISTS). Also create the tables by including the raw SQL in a comment block in the admin HTML so I can paste it into Supabase SQL editor if needed.

### Table: `crm_companies`
```sql
CREATE TABLE IF NOT EXISTS crm_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  website TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  google_rating NUMERIC(2,1),
  google_reviews INTEGER,
  google_maps_url TEXT,
  industry TEXT DEFAULT 'HVAC',
  employee_count TEXT,
  annual_revenue TEXT,
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'prospect' CHECK (status IN ('prospect', 'contacted', 'qualified', 'customer', 'churned', 'dead')),
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `crm_contacts`
```sql
CREATE TABLE IF NOT EXISTS crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  email TEXT,
  email_type TEXT CHECK (email_type IN ('personal', 'role_based', 'unknown')),
  email_verified BOOLEAN DEFAULT false,
  zerobounce_status TEXT,
  phone TEXT,
  phone_source TEXT,
  title TEXT,
  is_owner BOOLEAN DEFAULT false,
  linkedin_url TEXT,
  notes TEXT,
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'qualified', 'customer', 'unsubscribed', 'bounced')),
  last_contacted_at TIMESTAMPTZ,
  outreach_channel TEXT,
  campaign_id TEXT,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `crm_activities`
```sql
CREATE TABLE IF NOT EXISTS crm_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES crm_companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('email_sent', 'email_received', 'call_made', 'call_received', 'sms_sent', 'sms_received', 'note', 'meeting', 'status_change')),
  subject TEXT,
  body TEXT,
  outcome TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### Table: `crm_deals`
```sql
CREATE TABLE IF NOT EXISTS crm_deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES crm_companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  value NUMERIC(10,2),
  monthly_value NUMERIC(10,2),
  stage TEXT DEFAULT 'lead' CHECK (stage IN ('lead', 'contacted', 'demo_scheduled', 'proposal_sent', 'negotiation', 'closed_won', 'closed_lost')),
  tier TEXT,
  close_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Add indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_contacts_company ON crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON crm_contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_is_owner ON crm_contacts(is_owner);
CREATE INDEX IF NOT EXISTS idx_companies_status ON crm_companies(status);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON crm_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_company ON crm_activities(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON crm_deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_company ON crm_deals(company_id);
```

Disable RLS on all crm_ tables (we're using service role key):
```sql
ALTER TABLE crm_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON crm_companies FOR ALL USING (true);
CREATE POLICY "service_role_all" ON crm_contacts FOR ALL USING (true);
CREATE POLICY "service_role_all" ON crm_activities FOR ALL USING (true);
CREATE POLICY "service_role_all" ON crm_deals FOR ALL USING (true);
```

## Pages to Build

### 1. `/admin/index.html` — Login + Dashboard
- Simple password input. On submit, check password === 'sprint2026!', store in localStorage, redirect to dashboard.
- **Dashboard** shows:
  - Total companies, contacts, deals
  - Contacts by status (pie or bar chart — use Chart.js CDN)
  - Deal pipeline summary (count + total value per stage)
  - Recent activity feed (last 20 activities)
  - Quick action buttons: "Add Company", "Add Contact", "Import Leads"

### 2. `/admin/companies.html` — Companies List + Detail
- **List view:** Table with columns: Name, City/State, Phone, Status, Contacts#, Deals#, Last Activity
  - Search bar (filters by name, city)
  - Filter by status dropdown
  - Sort by columns (click header)
  - Pagination (25 per page)
  - Bulk select + bulk status change
- **Add/Edit modal:** Form with all company fields
- **Company detail view** (click row to expand or navigate):
  - Company info card (editable inline)
  - Contacts tab — list all contacts for this company, add new
  - Deals tab — list deals, add new
  - Activity timeline — all activities for this company
  - Notes section

### 3. `/admin/contacts.html` — Contacts List + Detail
- **List view:** Table with columns: Name, Email, Phone, Company, Title, Owner?, Status, Verified?, Last Contacted
  - Search bar (filters by name, email, company)
  - Filters: status, is_owner, email_verified, email_type
  - Sort by columns
  - Pagination (25 per page)
  - "Owners First" toggle — sorts is_owner=true to top
  - Bulk select + bulk status change
- **Add/Edit modal:** Form with all contact fields, company dropdown
- **Contact detail view:**
  - Contact info card (editable)
  - Company link
  - Activity timeline
  - Quick actions: Log Call, Log Email, Add Note
  - "Copy Email" button, "Open LinkedIn" button (if linkedin_url set)

### 4. `/admin/pipeline.html` — Deal Pipeline (Kanban)
- Kanban board with columns for each deal stage
- Cards show: deal name, company, value, contact name
- Drag and drop between stages (use SortableJS CDN: https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js)
- Click card to edit deal details
- "Add Deal" button

### 5. `/admin/import.html` — Bulk Import
- **CSV upload** with field mapping
- **Paste JSON** textarea for programmatic import
- Preview table before confirming import
- Deduplication check on email/company name
- Import creates both company and contact records
- Show import results: created, skipped (duplicate), errors

## Navigation
All admin pages share a sidebar nav:
- ❄️ SprintAI CRM (logo/title)
- 📊 Dashboard
- 🏢 Companies
- 👤 Contacts
- 💰 Pipeline
- 📥 Import
- ← Back to Site (link to /)

Use a shared `admin/nav.js` that injects the sidebar HTML into each page.

## Shared Code

### `admin/lib.js` — Shared utilities
- Supabase client init (URL + service role key)
- Auth check (redirect to login if not authenticated)
- Date formatting helpers
- Status badge component (returns HTML string with colored badge)
- Toast notification system
- Modal open/close helpers
- Pagination helper

### `admin/nav.js` — Sidebar navigation
- Inject sidebar HTML
- Highlight active page
- Collapse on mobile (hamburger)

### `admin/style.css` — Shared admin styles (minimal — mostly Tailwind)

## Design Guidelines
- Use Tailwind CDN (already loaded on the site): `<script src="https://cdn.tailwindcss.com"></script>`
- Primary color: indigo-600
- Background: gray-50
- Cards: white with shadow-sm, rounded-lg
- Tables: striped, hover effect
- Modals: centered overlay with backdrop blur
- Responsive: works on tablet + desktop (mobile is secondary)
- Status badges use colored pills:
  - prospect/new: gray
  - contacted: blue
  - qualified/replied: yellow
  - customer/closed_won: green
  - churned/dead/bounced/closed_lost: red

## CDN Libraries to Include
```html
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
```

## Redirects (add to netlify.toml)
```toml
# Admin CRM
[[redirects]]
  from = "/admin"
  to = "/admin/index.html"
  status = 200
```

## IMPORTANT
- Do NOT modify the existing `index.html`, `terms.html`, `privacy.html`, or `process/index.html`
- Do NOT modify existing Netlify functions
- All new files go in the `admin/` directory
- Use the SERVICE_ROLE key in the client-side JS (this is an admin panel behind a password wall, not public)
- Commit all changes with message: "feat: add CRM admin panel with companies, contacts, pipeline, import"

## Testing
After building, verify:
1. Password gate works (wrong password rejected, correct password grants access)
2. Can create a company
3. Can create a contact linked to a company
4. Can log an activity
5. Can create a deal
6. Kanban drag-and-drop works
7. Search and filters work
8. Import page accepts JSON paste
