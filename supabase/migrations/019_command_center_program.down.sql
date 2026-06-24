-- DOWN for 019_command_center_program.sql
-- Drops ONLY the objects 019 created. No existing table/data is affected
-- (program_items and everything else predating 019 is untouched).
-- Fully idempotent: dropping a table with IF EXISTS also removes its triggers
-- and RLS policies, so we drop tables first, then the shared trigger function.
-- Safe to re-run even after the tables are already gone.

DROP TABLE IF EXISTS program_epics;
DROP TABLE IF EXISTS program_tasks;
DROP TABLE IF EXISTS program_milestones;
DROP TABLE IF EXISTS program_launch_path;
DROP TABLE IF EXISTS program_risks;
DROP TABLE IF EXISTS program_decisions;
DROP TABLE IF EXISTS program_compliance;
DROP TABLE IF EXISTS program_team;
DROP TABLE IF EXISTS program_activity;
DROP TABLE IF EXISTS program_series_a;
DROP TABLE IF EXISTS program_meta;

-- Shared trigger fn created by 019. Dropped last (all triggers that used it are
-- gone with their tables above). NOT shared with program_items, which uses its
-- own set_program_items_updated_at from migration 016 — that fn is left intact.
DROP FUNCTION IF EXISTS set_program_updated_at();
