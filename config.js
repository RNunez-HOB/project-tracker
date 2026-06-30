// ============================================================
//  EDIT THESE TWO VALUES, then save and re-deploy.
//  Find them in Supabase ▸ Project Settings ▸ API.
//   - SUPABASE_URL : "Project URL"
//   - SUPABASE_ANON_KEY : the "anon" / "public" key (safe to expose)
// ============================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://vwwoljbhtdjlqozziuzx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3d29samJodGRqbHFvenppdXp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzU3ODYsImV4cCI6MjA5ODMxMTc4Nn0.CR-O_ttTbFUR3W29NexfxON910eFhWbk07XSorPJGwM",

  // Cosmetic — change to your firm's name.
  APP_NAME: "Project Tracker",

  // Only these email domains may sign in (server-side enforced by
  // restrict-signin-domains.sql; this list gives instant feedback in the UI).
  // Keep this list in sync with that SQL file.
  ALLOWED_EMAIL_DOMAINS: ["houseofbeta.nl", "talent-pro.com", "redmore.eu", "houseofhr.com"],
};
