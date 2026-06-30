-- ============================================================
--  Feature: "Assigned to me" filter
--  Each user records the name(s) they're assigned under on the board, so the
--  free-text assignee names on tasks can be matched to the signed-in user.
--  Run ONCE in Supabase ▸ SQL Editor ▸ New query.
-- ============================================================

alter table public.profiles
  add column if not exists aliases text[] default '{}';

-- No RLS changes needed: existing policies already let each signed-in user read all
-- profiles and update their own row, so they can set their own aliases.
