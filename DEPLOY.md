# Deploy checklist — features release (v=13)

This release adds: assignee picker, profile preferences (default view/filter + light/dark
theme), admin role + accountability (soft-delete, "by <name>"), comments + @mentions, a
Team workload tab, and a Supabase keep-alive workflow.

## 1. Run the SQL (Supabase ▸ SQL Editor)
- Open `migrate-features.sql`. **Check the bootstrap line near the middle** —
  `update public.profiles set is_admin = true where email = 'roberto.nunez@houseofbeta.nl';`
  — change the email if the first admin should be someone else. Then run the whole file.
- (Already run earlier: `add-profile-aliases.sql`, `enable-realtime.sql`. No need to re-run,
  but re-running is harmless — all idempotent.)

## 2. Push the code (from `repo\project-tracker`)
```
del .git\index.lock
git add -A
git commit -m "Features: assignee picker, prefs, admin+audit, comments, Team tab, keep-alive (v=13)"
git push origin main
```
Cloudflare Pages auto-builds. Hard-refresh the site (Ctrl+Shift+R) once after it deploys.

## 3. Turn on the keep-alive
- The push adds `.github/workflows/keepalive.yml`. On GitHub: repo → **Actions** tab. If it
  asks to enable workflows, click enable. Open **supabase-keepalive** → **Run workflow**
  once to confirm it goes green. After that it runs daily and the project won't auto-pause.
- (The URL + anon key are hardcoded in the workflow; both are already public in config.js,
  so there's nothing secret to configure.)

## 4. Smoke test
- Sign in → board loads. Open a task → assignee field is now a chip picker (type a teammate's
  name → suggestion appears; type a non-user + Enter → ad-hoc chip).
- Settings (top bar) → set default view / filter / theme → save → reload → it sticks.
- As the bootstrapped admin you see "Delete permanently"; the default remove now "Archives".
- A teammate who didn't create a task can Archive it but not hard-delete (RLS-enforced).
- Open a task → Comments section; type `@` → mention autocomplete; post → appears live.
- Team tab → open-task counts per person; click a person → board filtered to them.

## Notes
- The app degrades gracefully if the SQL hasn't run yet (features that need new columns
  just no-op with a hint toast), but run the SQL first for the full experience.
- Notifications/digests (roadmap feature 6) were intentionally scoped to just the keep-alive
  for now; the rest of that spec remains in SPECS.md for later.
