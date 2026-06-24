-- SprintAI — Command Center FULL program view, kept LIVE (feat/command-center-restore).
--
-- The "live" rebuild (0ebbecd) kept 4 operational panels but dropped the entire
-- program-management dashboard. This migration restores that dashboard's editorial
-- content as ADMIN-RLS DB ROWS (not hand-edited HTML), so the page derives every
-- rollup at view-time and updates are row writes, never redeploys.
--
-- New tables (all same shape/policy as program_items from migration 016):
--   program_epics, program_tasks, program_milestones, program_launch_path,
--   program_risks, program_decisions, program_compliance, program_team,
--   program_activity, program_series_a, program_meta
--
-- Each gets:
--   * a stable UNIQUE key column for idempotent seeding (WHERE NOT EXISTS),
--   * admin-only RLS: auth.jwt()->'user_metadata'->>'is_admin' = 'true',
--   * an updated_at trigger.
--
-- ADDITIVE ONLY. No drops, no edits of existing tables. Idempotent
-- (CREATE ... IF NOT EXISTS, guarded policies, seed by stable key). Reversible:
-- see 019_command_center_program.down.sql. The live order/messaging/billing path
-- never reads or writes any of these tables.

-- ============================================================
-- shared: generic updated_at trigger fn (idempotent CREATE OR REPLACE)
-- ============================================================
CREATE OR REPLACE FUNCTION set_program_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Helper: apply admin RLS policy + updated_at trigger to a program_* table.
-- (Inlined per-table below rather than a function, so the migration stays plain
--  DDL that the management SQL endpoint runs in one shot.)

-- ============================================================
-- program_epics — workstream META (rollups derived from program_tasks)
-- ============================================================
CREATE TABLE IF NOT EXISTS program_epics (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  epic_key    TEXT        UNIQUE NOT NULL,        -- stable id ('payments', ...)
  name        TEXT        NOT NULL,
  owner       TEXT        NOT NULL DEFAULT '',
  status_label TEXT       NOT NULL DEFAULT '',     -- e.g. 'Verified'
  status_tone TEXT        NOT NULL DEFAULT 'todo', -- done|progress|todo
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_epics ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_epics_updated_at ON program_epics;
CREATE TRIGGER trg_program_epics_updated_at BEFORE UPDATE ON program_epics
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_epics' AND policyname='Admins have full access to program_epics') THEN
    CREATE POLICY "Admins have full access to program_epics" ON program_epics
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_tasks — kanban cards (the PRIMARY input; rollups derive from these)
-- ============================================================
CREATE TABLE IF NOT EXISTS program_tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_key    TEXT        UNIQUE NOT NULL,
  title       TEXT        NOT NULL,
  epic_key    TEXT        NOT NULL,               -- links to program_epics.epic_key
  column_name TEXT        NOT NULL DEFAULT 'To Do'
                CHECK (column_name IN ('To Do','In Progress','In Review','Done','Blocked')),
  priority    TEXT,                               -- nullable ('High', ...)
  evidence    TEXT,                               -- artifact ref (required to reach Done)
  blocker     TEXT,                               -- shown on Blocked cards
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_program_tasks_epic ON program_tasks (epic_key, sort_order);
ALTER TABLE program_tasks ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_tasks_updated_at ON program_tasks;
CREATE TRIGGER trg_program_tasks_updated_at BEFORE UPDATE ON program_tasks
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_tasks' AND policyname='Admins have full access to program_tasks') THEN
    CREATE POLICY "Admins have full access to program_tasks" ON program_tasks
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_milestones — roadmap / phase timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS program_milestones (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_key TEXT      UNIQUE NOT NULL,
  phase       TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'upcoming'
                CHECK (status IN ('done','active','upcoming')),
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_milestones ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_milestones_updated_at ON program_milestones;
CREATE TRIGGER trg_program_milestones_updated_at BEFORE UPDATE ON program_milestones
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_milestones' AND policyname='Admins have full access to program_milestones') THEN
    CREATE POLICY "Admins have full access to program_milestones" ON program_milestones
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_launch_path — the prominent launch-critical-path card
-- ============================================================
CREATE TABLE IF NOT EXISTS program_launch_path (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  step_key    TEXT        UNIQUE NOT NULL,
  title       TEXT        NOT NULL,
  detail      TEXT        NOT NULL DEFAULT '',
  state       TEXT        NOT NULL DEFAULT 'todo'
                CHECK (state IN ('progress','blocked','todo','done')),
  label       TEXT        NOT NULL DEFAULT '',
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_launch_path ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_launch_path_updated_at ON program_launch_path;
CREATE TRIGGER trg_program_launch_path_updated_at BEFORE UPDATE ON program_launch_path
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_launch_path' AND policyname='Admins have full access to program_launch_path') THEN
    CREATE POLICY "Admins have full access to program_launch_path" ON program_launch_path
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_risks — risk register
-- ============================================================
CREATE TABLE IF NOT EXISTS program_risks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_key    TEXT        UNIQUE NOT NULL,
  risk        TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'Med',     -- Low|Med|High (display)
  likelihood  TEXT        NOT NULL DEFAULT 'Med',
  status_label TEXT       NOT NULL DEFAULT 'Open',
  status_tone TEXT        NOT NULL DEFAULT 'open',     -- open|progress
  mitigation  TEXT        NOT NULL DEFAULT '',
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_risks ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_risks_updated_at ON program_risks;
CREATE TRIGGER trg_program_risks_updated_at BEFORE UPDATE ON program_risks
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_risks' AND policyname='Admins have full access to program_risks') THEN
    CREATE POLICY "Admins have full access to program_risks" ON program_risks
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_decisions — locked (ADR) + open (needs founder) decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS program_decisions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key TEXT       UNIQUE NOT NULL,
  kind        TEXT        NOT NULL DEFAULT 'locked'
                CHECK (kind IN ('locked','open')),
  text        TEXT        NOT NULL,
  owner       TEXT,                                   -- set for open decisions
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_decisions ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_decisions_updated_at ON program_decisions;
CREATE TRIGGER trg_program_decisions_updated_at BEFORE UPDATE ON program_decisions
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_decisions' AND policyname='Admins have full access to program_decisions') THEN
    CREATE POLICY "Admins have full access to program_decisions" ON program_decisions
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_compliance — compliance & readiness
-- ============================================================
CREATE TABLE IF NOT EXISTS program_compliance (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key    TEXT        UNIQUE NOT NULL,
  item        TEXT        NOT NULL,
  status_text TEXT        NOT NULL DEFAULT '',
  state       TEXT        NOT NULL DEFAULT 'open'
                CHECK (state IN ('done','progress','open')),
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_compliance ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_compliance_updated_at ON program_compliance;
CREATE TRIGGER trg_program_compliance_updated_at BEFORE UPDATE ON program_compliance
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_compliance' AND policyname='Admins have full access to program_compliance') THEN
    CREATE POLICY "Admins have full access to program_compliance" ON program_compliance
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_team — build crew / agents
-- ============================================================
CREATE TABLE IF NOT EXISTS program_team (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  member_key  TEXT        UNIQUE NOT NULL,
  name        TEXT        NOT NULL,
  role        TEXT        NOT NULL DEFAULT '',
  model       TEXT        NOT NULL DEFAULT '',
  load_text   TEXT        NOT NULL DEFAULT '',
  color       TEXT        NOT NULL DEFAULT '#16212E',
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_team ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_team_updated_at ON program_team;
CREATE TRIGGER trg_program_team_updated_at BEFORE UPDATE ON program_team
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_team' AND policyname='Admins have full access to program_team') THEN
    CREATE POLICY "Admins have full access to program_team" ON program_team
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_activity — recent activity feed (rendered as PLAIN TEXT)
-- ============================================================
CREATE TABLE IF NOT EXISTS program_activity (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_key TEXT       UNIQUE NOT NULL,
  when_label  TEXT        NOT NULL DEFAULT '',
  text        TEXT        NOT NULL,               -- plain text; NOT innerHTML
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_activity ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_activity_updated_at ON program_activity;
CREATE TRIGGER trg_program_activity_updated_at BEFORE UPDATE ON program_activity
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_activity' AND policyname='Admins have full access to program_activity') THEN
    CREATE POLICY "Admins have full access to program_activity" ON program_activity
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_series_a — Series A readiness
-- ============================================================
CREATE TABLE IF NOT EXISTS program_series_a (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key    TEXT        UNIQUE NOT NULL,
  item        TEXT        NOT NULL,
  status_text TEXT        NOT NULL DEFAULT '',
  state       TEXT        NOT NULL DEFAULT 'open'
                CHECK (state IN ('done','progress','open')),
  sort_order  INTEGER     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_series_a ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_series_a_updated_at ON program_series_a;
CREATE TRIGGER trg_program_series_a_updated_at BEFORE UPDATE ON program_series_a
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_series_a' AND policyname='Admins have full access to program_series_a') THEN
    CREATE POLICY "Admins have full access to program_series_a" ON program_series_a
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================
-- program_meta — small key/value for roadmap axis (changeable)
-- ============================================================
CREATE TABLE IF NOT EXISTS program_meta (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_key    TEXT        UNIQUE NOT NULL,
  meta_value  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE program_meta ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_program_meta_updated_at ON program_meta;
CREATE TRIGGER trg_program_meta_updated_at BEFORE UPDATE ON program_meta
  FOR EACH ROW EXECUTE FUNCTION set_program_updated_at();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='program_meta' AND policyname='Admins have full access to program_meta') THEN
    CREATE POLICY "Admins have full access to program_meta" ON program_meta
      FOR ALL USING (auth.jwt()->'user_metadata'->>'is_admin' = 'true');
  END IF;
END $$;

-- ============================================================================
-- SEED — faithful transcription of command-center.html DATA (state 2026-06-21).
-- Idempotent: WHERE NOT EXISTS by the stable key column. Numbers are NOT seeded;
-- every rollup is derived at view-time in the component.
-- ============================================================================

-- ---- program_epics ----
INSERT INTO program_epics (epic_key, name, owner, status_label, status_tone, sort_order)
SELECT * FROM (VALUES
  ('payments','Stripe Connect Core (payments)','John Walsh / Melvin','Verified','done',10),
  ('checkout','Checkout Destination Charge + $0.99 fee','John Walsh / Melvin','Verified','done',20),
  ('menu','Menu Intake Pipeline','John Walsh / Melvin','Verified','done',30),
  ('wizard','Guided Signup Wizard (spec 05)','John Walsh','Conditional pass','progress',40),
  ('security','Merchant RLS Security Lockdown','John Walsh / Melvin','Verified','done',50),
  ('hours','Hours-Capture Fix (launch-critical)','John Walsh','In progress','progress',60),
  ('subscription','Subscription Billing ($49/mo)','Unassigned','Spec written','todo',70),
  ('cmdcenter','PM Command Center','SprintAI_bot','In progress','progress',80)
) AS v(epic_key, name, owner, status_label, status_tone, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_epics p WHERE p.epic_key = v.epic_key);

-- ---- program_tasks ----
INSERT INTO program_tasks (task_key, title, epic_key, column_name, priority, evidence, blocker, sort_order)
SELECT * FROM (VALUES
  ('pay-1','Stripe Connect destination charge + $0.99 application fee','payments','Done',NULL,'VERIFIED.md',NULL,10),
  ('pay-2','Go-live gate isShopLive() refuses charges until shop ready','payments','Done',NULL,'VERIFIED.md',NULL,20),
  ('pay-3','Migrations 007/008 (additive) for Connect onboarding','payments','Done',NULL,'supabase/migrations',NULL,30),
  ('pay-4','LIVE test-mode charge proof','payments','Blocked','High',NULL,'Awaiting Jason: Stripe test config + Connect client id/redirect/webhook',40),
  ('chk-1','Negative-margin bug closed; $0.99 shown as diner line item','checkout','Done',NULL,'VERIFIED.md',NULL,50),
  ('chk-2','Refund-the-fee on full refund implemented','checkout','Done',NULL,'VERIFIED.md',NULL,60),
  ('menu-1','Deterministic 7-col CSV + never-invent-price rule','menu','Done',NULL,'menu-pipeline',NULL,70),
  ('menu-2','Idempotent Stage B importer preserves owner edits (migration 010)','menu','Done',NULL,'supabase/migrations/010',NULL,80),
  ('menu-3','Real Jack''s Slice menu run through pipeline','menu','Done',NULL,'menu-pipeline fixtures',NULL,90),
  ('wiz-1','Guided signup wizard front-end (two-panel, scripted chat)','wizard','Done',NULL,'BUILD-REPORT-05.md',NULL,100),
  ('wiz-2','Merge Stripe + menu + connect onto wizard-05','wizard','Done',NULL,'git: wizard-05',NULL,110),
  ('wiz-3','Jack''s menu → 221 items / 39 option groups / 110 choices','wizard','Done',NULL,'BUILD-REPORT-05.md',NULL,120),
  ('wiz-4','Fix menu parser "or"-phrasing in price lists (e.g. "+$6 or +$8")','wizard','In Progress','High',NULL,NULL,130),
  ('sec-1','Migration 012: drop 3 anon policies + REVOKE anon','security','Done',NULL,'supabase/migrations/012',NULL,140),
  ('sec-2','merchant-auth edge fn: server-side PIN verify + 12h HMAC token','security','Done',NULL,'verified PASS 2026-06-21',NULL,150),
  ('sec-3','shop_id derived from token (not request body) — tenant-safe','security','Done',NULL,'verified PASS 2026-06-21',NULL,160),
  ('sec-4','Deploy with MERCHANT_AUTH_SECRET set in Supabase','security','Blocked','High',NULL,'Awaiting Jason: set MERCHANT_AUTH_SECRET in Supabase',170),
  ('hrs-1','Wizard collects real open/close times (hours capture)','hours','In Progress','High',NULL,NULL,180),
  ('sub-1','Subscription billing ($49/mo) build','subscription','To Do',NULL,NULL,NULL,190),
  ('cc-1','Command Center Stage 1 — real-data population','cmdcenter','In Progress',NULL,NULL,NULL,200),
  ('cc-2','Command Center Stage 2 — wire to live program store','cmdcenter','To Do',NULL,NULL,NULL,210)
) AS v(task_key, title, epic_key, column_name, priority, evidence, blocker, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_tasks p WHERE p.task_key = v.task_key);

-- ---- program_milestones ----
INSERT INTO program_milestones (milestone_key, phase, start_date, end_date, status, sort_order)
SELECT * FROM (VALUES
  ('m1','Foundation — specs & architecture','2026-04-15'::date,'2026-06-05'::date,'done',10),
  ('m2','Core build — payments, menu, wizard, security','2026-05-20'::date,'2026-06-30'::date,'active',20),
  ('m3','Launch prep — hours, live charge, Twilio, menu load','2026-06-15'::date,'2026-07-15'::date,'active',30),
  ('m4','Pilot — Jack''s Slice + Not Just Bagels','2026-07-10'::date,'2026-09-15'::date,'upcoming',40),
  ('m5','Post-launch builds — Admin, CRM, Eval Loop','2026-09-01'::date,'2026-12-15'::date,'upcoming',50),
  ('m6','GA & scale','2026-12-01'::date,'2027-04-01'::date,'upcoming',60),
  ('m7','Series A readiness','2027-03-01'::date,'2027-06-15'::date,'upcoming',70)
) AS v(milestone_key, phase, start_date, end_date, status, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_milestones p WHERE p.milestone_key = v.milestone_key);

-- ---- program_launch_path ----
INSERT INTO program_launch_path (step_key, title, detail, state, label, sort_order)
SELECT * FROM (VALUES
  ('lp1','Hours-capture fix','Wizard collects real open/close times so the bot knows when to take orders.','progress','In progress',10),
  ('lp2','Stripe test config → live $0.99 charge proof','Jason sets Stripe test-mode + Connect creds; we prove one real $0.99 charge end-to-end.','blocked','Needs Jason',20),
  ('lp3','Real Twilio number + SMS test','Provision a real number and prove an inbound/outbound order text round-trip.','todo','Not started',30),
  ('lp4','Jack''s menu loaded via verified pipeline','Run Jack''s Slice menu through the verified importer into the live shop.','todo','Not started',40)
) AS v(step_key, title, detail, state, label, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_launch_path p WHERE p.step_key = v.step_key);

-- ---- program_risks ----
INSERT INTO program_risks (risk_key, risk, severity, likelihood, status_label, status_tone, mitigation, sort_order)
SELECT * FROM (VALUES
  ('r1','Live charge path unproven until Stripe test config set','Med','High','Open','open','Blocks launch proof. Awaiting Jason: Stripe test key + Connect client id/redirect/webhook secret.',10),
  ('r2','Menu parser "or"-phrasing gap','Med','Med','Open','open','Fix in progress today; could break real-menu imports at scale if unaddressed.',20),
  ('r3','A2P 10DLC campaign status unconfirmed','Med','Med','Open','open','Was IN_PROGRESS in prior records — verify before any real SMS send.',30),
  ('r4','Production shares OpenClaw/build environment','Med','Med','Monitored','progress','Independence Spec wants full separation; post-launch cutover required before scaling past pilot.',40),
  ('r5','Merchant auth tokens not revocable mid-session (12h)','Low','Low','Monitored','progress','Accepted for now; replaced when SprintAdmin lands.',50)
) AS v(risk_key, risk, severity, likelihood, status_label, status_tone, mitigation, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_risks p WHERE p.risk_key = v.risk_key);

-- ---- program_decisions (locked) ----
INSERT INTO program_decisions (decision_key, kind, text, owner, sort_order)
SELECT * FROM (VALUES
  ('d-locked-1','locked','Subscription stays $49/mo single tier; $0.99/order is the profit engine',NULL,10),
  ('d-locked-2','locked','Stripe Connect destination charges (not hold-and-remit) — avoids money-transmitter status; restaurant owns food funds, Sprint takes $0.99',NULL,20),
  ('d-locked-3','locked','$0.99 is a platform service fee shown before payment, NOT a card surcharge',NULL,30),
  ('d-locked-4','locked','Restaurants own their customers; tenant isolation is absolute',NULL,40),
  ('d-locked-5','locked','Customer Care SMS posture only — no marketing texts (protects 10DLC)',NULL,50),
  ('d-locked-6','locked','Model proposes / backend disposes on all LLM surfaces; server-authoritative money',NULL,60),
  ('d-locked-7','locked','Build toward SOC 2 Type II but do NOT start certification now (founder-triggered later)',NULL,70),
  ('d-locked-8','locked','Zero runtime dependency on build agents (Independence Spec); secrets in admin panel, not chat/code',NULL,80),
  ('d-locked-9','locked','Done = observable artifact + Melvin sign-off, never a self-report',NULL,90),
  ('d-open-1','open','Set Stripe test-mode config + repoint STRIPE_SECRET_KEY to test key + add Connect client id/redirect/webhook secret (gates live charge proof)','Jason',100),
  ('d-open-2','open','Set MERCHANT_AUTH_SECRET in Supabase (gates security-lockdown deploy)','Jason',110),
  ('d-open-3','open','SprintAdmin spec (incoming) — gates credential-management UI + super-admin console','Jason',120),
  ('d-open-4','open','Subscription billing build — go / no-go','Jason',130),
  ('d-open-5','open','CRM phasing confirm (Phase 1 recognition + "the usual"; Phase 2 marketing+compliance later) — leaning yes','Jason',140),
  ('d-open-6','open','Inactive-customer data: auto-anonymize after years inactive (recommended) vs. keep forever','Jason',150)
) AS v(decision_key, kind, text, owner, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_decisions p WHERE p.decision_key = v.decision_key);

-- ---- program_compliance ----
INSERT INTO program_compliance (item_key, item, status_text, state, sort_order)
SELECT * FROM (VALUES
  ('c1','10DLC A2P','In progress — verify before SMS','progress',10),
  ('c2','PCI DSS — SAQ A (by design)','On track by architecture','done',20),
  ('c3','TCPA / Customer-Care SMS posture','Designed-in (no marketing)','done',30),
  ('c4','SOC 2 Type II','Design-toward only','progress',40),
  ('c5','CCPA / CPRA — deletion & access','Spec''d (CRM Phase 2), not built','open',50),
  ('c6','Security launch checklist','Partial — merchant-auth hole closed today','progress',60)
) AS v(item_key, item, status_text, state, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_compliance p WHERE p.item_key = v.item_key);

-- ---- program_team ----
INSERT INTO program_team (member_key, name, role, model, load_text, color, sort_order)
SELECT * FROM (VALUES
  ('t1','SprintAI_bot','Lead / orchestrator — specs, pre-mortems, integrate; never writes prod code or self-certifies','Opus','Coordinating','#E8521A',10),
  ('t2','John Walsh','Coding agent — writes all code to spec','Sonnet','Parser + hours fixes','#16212E',20),
  ('t3','Melvin','QA / verifier — independent; the only path to Done; observable artifacts only','Sonnet','Verifying','#3B82C4',30)
) AS v(member_key, name, role, model, load_text, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_team p WHERE p.member_key = v.member_key);

-- ---- program_activity (plain text) ----
INSERT INTO program_activity (activity_key, when_label, text, sort_order)
SELECT * FROM (VALUES
  ('a1','today','Merchant RLS lockdown verified PASS — anon hole closed, tenant-safe tokens',10),
  ('a2','today','Menu intake pipeline verified — real Jack''s menu through importer',20),
  ('a3','today','Stripe Connect + checkout verified — $0.99 fee, refund-fee, go-live gate',30),
  ('a4','today','Signup wizard built (conditional pass) — 221 items / 39 groups / 110 choices',40),
  ('a5','today','Parser "or"-phrasing fix and hours-capture fix in progress',50),
  ('a6','today','Command Center Stage 1 in progress (this build)',60)
) AS v(activity_key, when_label, text, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_activity p WHERE p.activity_key = v.activity_key);

-- ---- program_series_a ----
INSERT INTO program_series_a (item_key, item, status_text, state, sort_order)
SELECT * FROM (VALUES
  ('sa1','Repeatable self-serve onboarding','Wizard built; pilot pending','progress',10),
  ('sa2','Pilot traction','Jack''s Slice + Not Just Bagels pending go-live','progress',20),
  ('sa3','Compliance & security posture','PCI SAQ A by design; SOC 2 design-toward','progress',30),
  ('sa4','Unit economics','$49/mo + $0.99/order','done',40),
  ('sa5','Conversational differentiation (moat)','Quality + Evaluation Loop flywheel','progress',50)
) AS v(item_key, item, status_text, state, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM program_series_a p WHERE p.item_key = v.item_key);

-- ---- program_meta (roadmap axis — changeable) ----
INSERT INTO program_meta (meta_key, meta_value)
SELECT * FROM (VALUES
  ('roadmap_axis_start','2026-04-01'),
  ('roadmap_axis_end','2027-07-01')
) AS v(meta_key, meta_value)
WHERE NOT EXISTS (SELECT 1 FROM program_meta p WHERE p.meta_key = v.meta_key);

-- ============================================================================
-- ROLLBACK: see 019_command_center_program.down.sql. Purely additive — creates
-- 11 NEW tables + their triggers/policies + one shared trigger fn, and seeds
-- editorial rows keyed by stable *_key columns. Touches no existing table.
-- ============================================================================
