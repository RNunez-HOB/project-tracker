/* ============================================================
   Project Tracker — front-end logic (no build step required)
   ============================================================ */
(function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON");

  const $ = (id) => document.getElementById(id);
  const STATUSES = [
    { key: "todo", label: "To do", color: "#94a3b8" },
    { key: "in_progress", label: "In progress", color: "#0ea5e9" },
    { key: "blocked", label: "Blocked", color: "#f59e0b" },
    { key: "done", label: "Done", color: "#22c55e" },
  ];

  // App name from config
  const appName = cfg.APP_NAME || "Project Tracker";
  document.title = appName;
  $("auth-app-name").textContent = appName;
  $("brand-name").textContent = appName;

  if (!configured) {
    showAuth();
    $("auth-msg").className = "auth-msg err";
    $("auth-msg").innerHTML =
      "Not connected yet. Open <b>config.js</b> and paste your Supabase URL and anon key (see SETUP.md).";
    $("login-form").style.display = "none";
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    showAuth();
    $("login-form").style.display = "none";
    $("auth-msg").className = "auth-msg err";
    $("auth-msg").textContent =
      "Couldn't load the Supabase library — a network issue or ad-blocker may be blocking the CDN. Reload the page; if it persists, check your connection.";
    return;
  }

  // Some privacy-hardened browsers (strict tracking protection, private windows,
  // or "delete cookies on close" — common in Firefox/Waterfox) block site storage.
  // Supabase keeps the sign-in session in localStorage, so when it's blocked every
  // auth call throws (NS_ERROR_NOT_AVAILABLE) and the dashboard goes blank. Fall
  // back to an in-memory store so the app still works for the current tab.
  let storageBlocked = false;
  let authStorage;
  try {
    const k = "__pt_storage_test__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    authStorage = window.localStorage;
  } catch (_) {
    storageBlocked = true;
    const mem = {};
    authStorage = {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: (k) => { delete mem[k]; },
    };
  }

  // Use supabase-js's DEFAULT auth lock. Two custom locks were tried and both broke
  // restored sessions: a serialising queue wedged, and a no-op pass-through let the
  // concurrent init calls (getSession + onAuthStateChange + realtime) race and wedge
  // the auth client, so queries never got a token and the board never rendered. The
  // built-in Web Locks lock serialises those calls correctly.
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      storage: authStorage,      // localStorage, or in-memory if the browser blocks it
      flowType: "pkce",          // auth code exchange — token never appears in the URL
      detectSessionInUrl: true,  // process the code when the link lands
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  if (storageBlocked) {
    // The app works, but the session lives only in memory — gone on reload.
    setTimeout(() => toast(
      "This browser is blocking site storage, so you'll be signed out when you reload. " +
      "Allow cookies/storage for this site to stay signed in."
    ), 1200);
  }

  // In-memory state
  let projects = [];
  let tasks = [];
  let currentView = "board";
  let graphInst = null;
  let currentUserId = null;
  const filters = { search: "", project: "", assignee: "", tag: "" };

  /* ---------------- AUTH ---------------- */
  function showAuth() { $("auth-screen").classList.remove("hidden"); $("app").classList.add("hidden"); }
  function showApp()  { $("auth-screen").classList.add("hidden"); $("app").classList.remove("hidden"); }

  function clearUrlToken() {
    // Sign-in leaves auth params in the URL — an access token in the hash (implicit)
    // or a ?code=... (PKCE). Once signed in, strip them so reopening or restoring the
    // tab (Ctrl+Shift+T) can't replay stale auth and leave the app "logged in but frozen".
    if (window.location.hash || window.location.search) {
      try { history.replaceState(null, "", window.location.pathname); } catch (_) {}
    }
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const msg = $("auth-msg");

    // Domain allow-list. The Supabase trigger (restrict-signin-domains.sql) is the
    // real enforcement; this just gives immediate feedback and avoids emailing
    // links to addresses that can't sign in anyway.
    const allowed = cfg.ALLOWED_EMAIL_DOMAINS || [];
    const domain = (email.split("@")[1] || "").toLowerCase();
    if (allowed.length && !allowed.includes(domain)) {
      msg.className = "auth-msg err";
      msg.textContent = "Sign-in is restricted to approved company email addresses.";
      return;
    }

    msg.className = "auth-msg";
    msg.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) { msg.className = "auth-msg err"; msg.textContent = error.message; }
    else { msg.className = "auth-msg ok"; msg.textContent = "Check your email for the sign-in link."; }
  });

  $("signout-btn").addEventListener("click", async () => {
    // Clear the session locally first so sign-out always works, even if the
    // server call fails or the token is already invalid.
    try { await sb.auth.signOut({ scope: "local" }); } catch (_) {}
    showAuth();
  });

  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session && session.user) {
      currentUserId = session.user.id;
      $("user-email").textContent = session.user.email;
      showApp();
      clearUrlToken();
      await loadAll();
    } else {
      showAuth();
    }
  });

  // Handle initial session (e.g. returning from magic link)
  sb.auth.getSession().then(({ data }) => {
    if (data.session) {
      currentUserId = data.session.user.id;
      $("user-email").textContent = data.session.user.email;
      showApp();
      clearUrlToken();
      loadAll();
    } else {
      showAuth();
    }
  }).catch(() => showAuth());

  // Safety net: if auth init still hasn't shown either screen after 8s (e.g. a
  // network stall during getSession), fall back to the sign-in screen so the user
  // can retry instead of staring at a frozen blank page.
  setTimeout(() => {
    if ($("auth-screen").classList.contains("hidden") && $("app").classList.contains("hidden")) {
      showAuth();
      $("auth-msg").className = "auth-msg err";
      $("auth-msg").textContent = "Taking longer than usual to connect — check your connection and reload.";
    }
  }, 8000);

  /* ---------------- DATA ---------------- */
  let loadingNow = false;
  let reloadQueued = false;
  async function loadAll() {
    // Guard against overlapping fetches (realtime + polling + manual saves
    // can all fire at once). If a load is already running, queue one more.
    if (loadingNow) { reloadQueued = true; return; }
    loadingNow = true;
    try {
      // Race the load against a timeout so a stalled auth/query can never leave the
      // board blank forever. If it hangs, we surface it and retry instead of wedging.
      const [{ data: pj, error: e1 }, { data: tk, error: e2 }] = await Promise.race([
        Promise.all([
          sb.from("projects").select("*").eq("archived", false).order("created_at"),
          sb.from("tasks").select("*").order("deadline", { nullsFirst: false }),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Load timed out")), 12000)),
      ]);
      const err = e1 || e2;
      if (err) {
        // A dead/expired session makes every request fail and the board go
        // blank with no clue why. Recover to the sign-in screen instead of
        // leaving the user stuck.
        if (err.code === "PGRST301" || err.status === 401 ||
            /jwt|token|expired|not authenticated/i.test(err.message || "")) {
          try { await sb.auth.signOut({ scope: "local" }); } catch (_) {}
          showAuth();
          return;
        }
        toast("Couldn't load data: " + err.message);
        return;
      }
      projects = pj || [];
      tasks = tk || [];
      refreshFilters();
      render();
    } catch (e) {
      // Timed out or unexpected failure — never leave a silent blank board.
      toast("Couldn't load the board — retrying…");
      setTimeout(() => { if (currentUserId) loadAll(); }, 3000);
    } finally {
      loadingNow = false;
      if (reloadQueued) { reloadQueued = false; loadAll(); }
    }
  }

  // Live updates so consultants see each other's changes
  sb.channel("rt")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, loadAll)
    .subscribe();

  // Fallback so the board stays current even if the realtime socket drops:
  // poll every 20s while signed in, and refresh whenever the tab regains focus.
  setInterval(() => {
    if (currentUserId && document.visibilityState === "visible") loadAll();
  }, 20000);
  document.addEventListener("visibilitychange", () => {
    if (currentUserId && document.visibilityState === "visible") loadAll();
  });

  /* ---------------- FILTERS ---------------- */
  function refreshFilters() {
    const fp = $("filter-project");
    fp.innerHTML = '<option value="">All projects</option>' +
      projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    fp.value = filters.project;

    const people = new Set(), tags = new Set();
    tasks.forEach((t) => {
      (t.assignees || []).forEach((a) => people.add(a));
      (t.stakeholders || []).forEach((a) => people.add(a));
      (t.tags || []).forEach((a) => tags.add(a));
    });
    const fa = $("filter-assignee");
    fa.innerHTML = '<option value="">All people</option>' +
      [...people].sort().map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    fa.value = filters.assignee;

    const ft = $("filter-tag");
    ft.innerHTML = '<option value="">All tags</option>' +
      [...tags].sort().map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    ft.value = filters.tag;
  }

  function visibleTasks() {
    return tasks.filter((t) => {
      if (filters.project && t.project_id !== filters.project) return false;
      if (filters.assignee &&
          !(t.assignees || []).includes(filters.assignee) &&
          !(t.stakeholders || []).includes(filters.assignee)) return false;
      if (filters.tag && !(t.tags || []).includes(filters.tag)) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = [t.title, t.description, ...(t.tags||[]), ...(t.assignees||[]), ...(t.stakeholders||[])]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  $("search").addEventListener("input", (e) => { filters.search = e.target.value; render(); });
  $("filter-project").addEventListener("change", (e) => { filters.project = e.target.value; render(); });
  $("filter-assignee").addEventListener("change", (e) => { filters.assignee = e.target.value; render(); });
  $("filter-tag").addEventListener("change", (e) => { filters.tag = e.target.value; render(); });

  document.querySelectorAll(".view-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentView = tab.dataset.view;
      render();
    })
  );

  /* ---------------- RENDER ---------------- */
  function render() {
    const v = currentView;
    $("board-view").classList.toggle("hidden", v !== "board");
    $("list-view").classList.toggle("hidden", v !== "list");
    $("graph-view").classList.toggle("hidden", v !== "graph");
    if (v === "board") renderBoard();
    else if (v === "list") renderList();
    else renderGraph();
  }

  function renderGraph() {
    if (!window.SynapseGraph) return;
    if (!graphInst) {
      graphInst = window.SynapseGraph.mount($("graph-view"), {
        getProjects: () => projects,
        getTasks: () => tasks,
        statuses: () => STATUSES,
        openProject: (id) => {
          filters.project = id;
          currentView = "board";
          document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === "board"));
          $("filter-project").value = id;
          render();
        },
      });
    } else {
      graphInst.update();
    }
  }

  function projectFor(id) { return projects.find((p) => p.id === id); }

  function renderBoard() {
    const list = visibleTasks();
    const board = $("board-view");
    board.innerHTML = STATUSES.map((s) => {
      const items = list.filter((t) => t.status === s.key);
      return `<section class="column" data-status="${s.key}">
        <div class="col-head"><span class="col-dot" style="background:${s.color}"></span>${s.label}
          <span class="col-count">${items.length}</span></div>
        ${items.map(cardHTML).join("") || '<div class="empty">—</div>'}
      </section>`;
    }).join("");

    // open editor on click
    board.querySelectorAll(".card").forEach((c) =>
      c.addEventListener("click", () => openTask(c.dataset.id)));

    // drag & drop between columns
    board.querySelectorAll(".card").forEach((c) => {
      c.setAttribute("draggable", "true");
      c.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", c.dataset.id));
    });
    board.querySelectorAll(".column").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drag-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const id = e.dataTransfer.getData("text/plain");
        const status = col.dataset.status;
        const t = tasks.find((x) => x.id === id);
        if (t && t.status !== status) { t.status = status; render(); await updateTask(id, { status }); }
      });
    });
  }

  function cardHTML(t) {
    const p = projectFor(t.project_id);
    const late = isOverdue(t);
    const people = (t.assignees || []).slice(0, 4);
    return `<div class="card ${late ? "overdue" : ""}" data-id="${t.id}">
      ${p ? `<div class="card-proj"><span class="col-dot" style="background:${p.color}"></span>${esc(p.name)}</div>` : ""}
      <div class="card-title">${esc(t.title)}</div>
      ${(t.tags && t.tags.length) ? `<div class="chips">${t.tags.map((x)=>`<span class="chip tag">${esc(x)}</span>`).join("")}</div>` : ""}
      <div class="card-meta">
        <span class="pill pri-${t.priority || "medium"}">${t.priority || "medium"}</span>
        ${t.deadline ? `<span class="due ${late ? "late" : ""}">${fmtDate(t.deadline)}</span>` : ""}
        ${people.length ? `<span class="avatars">${people.map((a)=>`<span class="avatar" title="${esc(a)}">${initials(a)}</span>`).join("")}</span>` : ""}
      </div>
    </div>`;
  }

  function renderList() {
    const list = visibleTasks().slice().sort((a, b) =>
      (a.deadline || "9999").localeCompare(b.deadline || "9999"));
    const v = $("list-view");
    if (!list.length) { v.innerHTML = '<div class="empty">No tasks match your filters.</div>'; return; }
    v.innerHTML = `<table><thead><tr>
        <th>Task</th><th>Project</th><th>Status</th><th>Priority</th>
        <th>Deadline</th><th>People</th><th>Tags</th>
      </tr></thead><tbody>${list.map((t) => {
        const p = projectFor(t.project_id);
        const late = isOverdue(t);
        return `<tr data-id="${t.id}">
          <td><b>${esc(t.title)}</b></td>
          <td>${p ? `<span class="col-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:5px"></span>${esc(p.name)}` : "—"}</td>
          <td><span class="status-tag s-${t.status}">${statusLabel(t.status)}</span></td>
          <td><span class="pill pri-${t.priority||"medium"}">${t.priority||"medium"}</span></td>
          <td class="${late?"due late":""}">${t.deadline ? fmtDate(t.deadline) : "—"}</td>
          <td>${(t.assignees||[]).join(", ") || "—"}</td>
          <td>${(t.tags||[]).join(", ") || "—"}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
    v.querySelectorAll("tr[data-id]").forEach((r) =>
      r.addEventListener("click", () => openTask(r.dataset.id)));
  }

  /* ---------------- TASK MODAL ---------------- */
  function fillProjectSelect() {
    $("f-project").innerHTML = '<option value="">— none —</option>' +
      projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }

  function openTask(id) {
    fillProjectSelect();
    const t = tasks.find((x) => x.id === id);
    $("task-modal-title").textContent = t ? "Edit task" : "New task";
    $("task-id").value = t ? t.id : "";
    $("f-title").value = t ? t.title : "";
    $("f-description").value = t ? (t.description || "") : "";
    $("f-project").value = t ? (t.project_id || "") : (filters.project || "");
    $("f-status").value = t ? t.status : "todo";
    $("f-priority").value = t ? (t.priority || "medium") : "medium";
    $("f-deadline").value = t ? (t.deadline || "") : "";
    $("f-assignees").value = t ? (t.assignees || []).join(", ") : "";
    $("f-stakeholders").value = t ? (t.stakeholders || []).join(", ") : "";
    $("f-tags").value = t ? (t.tags || []).join(", ") : "";
    $("delete-task-btn").classList.toggle("hidden", !t);
    $("task-modal").classList.remove("hidden");
  }

  $("new-task-btn").addEventListener("click", () => openTask(null));

  $("task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("task-id").value;
    const payload = {
      title: $("f-title").value.trim(),
      description: $("f-description").value.trim() || null,
      project_id: $("f-project").value || null,
      status: $("f-status").value,
      priority: $("f-priority").value,
      deadline: $("f-deadline").value || null,
      assignees: splitList($("f-assignees").value),
      stakeholders: splitList($("f-stakeholders").value),
      tags: splitList($("f-tags").value),
    };
    closeModals();
    try {
      if (id) await updateTask(id, payload);
      else {
        payload.created_by = currentUserId;
        const { error } = await sb.from("tasks").insert(payload);
        if (error) return toast("Error: " + error.message);
        toast("Task added");
      }
      await loadAll();
    } catch (err) {
      toast("Couldn't save task: " + (err.message || err));
    }
  });

  $("delete-task-btn").addEventListener("click", async () => {
    const id = $("task-id").value;
    if (!id || !confirm("Delete this task permanently?")) return;
    closeModals();
    const { error } = await sb.from("tasks").delete().eq("id", id);
    toast(error ? "Error: " + error.message : "Task deleted");
    await loadAll();
  });

  async function updateTask(id, patch) {
    const { error } = await sb.from("tasks").update(patch).eq("id", id);
    if (error) toast("Error: " + error.message);
  }

  /* ---------------- PROJECTS MODAL ---------------- */
  $("manage-projects-btn").addEventListener("click", () => { renderProjectList(); $("project-modal").classList.remove("hidden"); });

  function renderProjectList() {
    $("project-list").innerHTML = projects.length
      ? projects.map((p) => `<div class="project-row" data-id="${p.id}">
          <span class="col-dot" style="background:${p.color}"></span>
          <span class="pname">${esc(p.name)}</span>
          <button class="btn btn-danger btn-sm" data-del="${p.id}">Archive</button>
        </div>`).join("")
      : '<div class="empty">No projects yet.</div>';
    $("project-list").querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Archive this project? Its tasks stay but lose the bucket.")) return;
        await sb.from("projects").update({ archived: true }).eq("id", b.dataset.del);
        await loadAll(); renderProjectList();
      }));
  }

  $("project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("p-name").value.trim();
    if (!name) return;
    try {
      const { error } = await sb.from("projects").insert({
        name, color: $("p-color").value, created_by: currentUserId,
      });
      if (error) return toast("Error: " + error.message);
      $("p-name").value = "";
      await loadAll(); renderProjectList();
    } catch (err) {
      toast("Couldn't save project: " + (err.message || err));
    }
  });

  /* ---------------- MODAL CLOSE ---------------- */
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModals));
  document.querySelectorAll(".modal-backdrop").forEach((bd) =>
    bd.addEventListener("click", (e) => { if (e.target === bd) closeModals(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
  function closeModals() { document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden")); }

  /* ---------------- HELPERS ---------------- */
  function splitList(s) { return s.split(",").map((x) => x.trim()).filter(Boolean); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function initials(name) {
    const p = name.trim().split(/\s+/);
    return ((p[0]?.[0] || "") + (p[1]?.[0] || "")).toUpperCase() || "?";
  }
  function statusLabel(k) { return (STATUSES.find((s) => s.key === k) || {}).label || k; }
  function fmtDate(d) {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function isOverdue(t) {
    if (!t.deadline || t.status === "done") return false;
    return t.deadline < new Date().toISOString().slice(0, 10);
  }
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
})();
