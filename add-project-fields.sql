-- ============================================================
--  Projects: add their own priority + tags (for the Projects tab)
--  Run ONCE in Supabase ▸ SQL Editor ▸ New query. Idempotent.
-- ============================================================
alter table public.projects
  add column if not exists priority text default 'medium';   -- low | medium | high
alter table public.projects
  add column if not exists tags text[] not null default '{}';

-- (Team members are derived from the assignees of each project's open tasks — no column
--  needed. RLS is unchanged: projects stay readable/writable by authenticated users,
--  with DELETE gated to creator/admin from migrate-features.sql.)
