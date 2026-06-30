-- ============================================================
--  Project Tracker — feature migration (prefs, admin/audit, comments)
--  Run ONCE in Supabase ▸ SQL Editor ▸ New query. All statements are idempotent,
--  so re-running is safe. (add-profile-aliases.sql is assumed already run.)
-- ============================================================

-- ===== Feature 2: per-user preferences (default view / filter / theme) =====
alter table public.profiles
  add column if not exists prefs jsonb not null default '{}'::jsonb;

-- ===== Feature 3: admin role + audit + soft-delete =====
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

alter table public.tasks
  add column if not exists updated_by uuid references auth.users(id);
alter table public.tasks
  add column if not exists archived boolean not null default false;
create index if not exists tasks_archived_idx on public.tasks(archived);

-- Is the calling user an admin? SECURITY DEFINER so the policy can read is_admin
-- regardless of row visibility.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ---- RLS: keep select/insert/update open to authenticated; gate DELETE ----
-- TASKS
drop policy if exists "tasks all"    on public.tasks;
drop policy if exists "tasks select" on public.tasks;
drop policy if exists "tasks insert" on public.tasks;
drop policy if exists "tasks update" on public.tasks;
drop policy if exists "tasks delete" on public.tasks;
create policy "tasks select" on public.tasks for select to authenticated using (true);
create policy "tasks insert" on public.tasks for insert to authenticated with check (true);
create policy "tasks update" on public.tasks for update to authenticated using (true) with check (true);
create policy "tasks delete" on public.tasks for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- PROJECTS
drop policy if exists "projects all"    on public.projects;
drop policy if exists "projects select" on public.projects;
drop policy if exists "projects insert" on public.projects;
drop policy if exists "projects update" on public.projects;
drop policy if exists "projects delete" on public.projects;
create policy "projects select" on public.projects for select to authenticated using (true);
create policy "projects insert" on public.projects for insert to authenticated with check (true);
create policy "projects update" on public.projects for update to authenticated using (true) with check (true);
create policy "projects delete" on public.projects for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- Prevent users from flipping their OWN is_admin (otherwise the gate is worthless).
-- They can still edit their own full_name / aliases / prefs.
drop policy if exists "profiles update" on public.profiles;
create policy "profiles update" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and is_admin = (select p.is_admin from public.profiles p where p.id = auth.uid())
  );

-- Bootstrap the first admin. EDIT the email to the real first admin, then it runs.
update public.profiles set is_admin = true
  where email = 'roberto.nunez@houseofbeta.nl';

-- ===== Feature 4: comments + @mentions =====
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null check (char_length(body) between 1 and 4000),
  mentions    uuid[] not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists comments_task_idx     on public.comments(task_id, created_at);
create index if not exists comments_mentions_idx on public.comments using gin (mentions);

alter table public.comments enable row level security;
drop policy if exists "comments read"   on public.comments;
drop policy if exists "comments insert" on public.comments;
drop policy if exists "comments delete" on public.comments;
create policy "comments read"   on public.comments for select to authenticated using (true);
create policy "comments insert" on public.comments for insert to authenticated with check (auth.uid() = author_id);
create policy "comments delete" on public.comments for delete to authenticated
  using (auth.uid() = author_id or public.is_admin());
-- (no UPDATE policy → comments are immutable)

-- Realtime for live comment threads (same mechanism as enable-realtime.sql).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments'
  ) then
    alter publication supabase_realtime add table public.comments;
  end if;
end $$;
alter table public.comments replica identity full;
