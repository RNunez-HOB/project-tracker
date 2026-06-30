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

  // Use supabase-js's DEFAULT auth lock (a custom one wedged restored sessions).
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      storage: authStorage,
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  if (storageBlocked) {
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
  let accessToken = null;
  let myAliases = [];          // lower-cased name(s) the signed-in user is assigned under
  let directory = [];          // [{id, full_name, email, aliases, is_admin}] — people directory
  let profileById = {};        // uuid -> profile
  let isAdmin = false;
  let myPrefs = {};            // { view, filter, theme }
  let prefsApplied = false;
  let openTaskId = null;       // task whose modal is open (for comments)
  let commentsCache = [];
  const SB_STORAGE_KEY = "sb-" + ((cfg.SUPABASE_URL.match(/^https?:\/\/([^.]+)\./) || [])[1] || "") + "-auth-token";
  const filters = { search: "", project: "", assignee: "", tag: "", mine: false };

  /* ---------------- AUTH ---------------- */
  function showAuth() { $("auth-screen").classList.remove("hidden"); $("app").classList.add("hidden"); }
  function showApp()  { $("auth-screen").classList.add("hidden"); $("app").classList.remove("hidden"); }

  function clearUrlToken() {
    if (window.location.hash || window.location.search) {
      try { history.replaceState(null, "", window.location.pathname); } catch (_) {}
    }
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const msg = $("auth-msg");
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
    try { await sb.auth.signOut({ scope: "local" }); } catch (_) {}
    showAuth();
  });

  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session && session.user) {
      currentUserId = session.user.id;
      accessToken = session.access_token;
      $("user-email").textContent = session.user.email;
      showApp();
      clearUrlToken();
      await loadAll();
    } else {
      accessToken = null;
      currentUserId = null;
      showAuth();
    }
  });

  // Fast path: render immediately from the stored token, without waiting on supabase-js
  // auth init (which can stall ~10s on its lock for a restored session).
  function earlyBoot() {
    const s = sessionFromStorage();
    if (s && s.access_token) {
      accessToken = s.access_token;
      currentUserId = s.user && s.user.id;
      if (s.user && s.user.email) $("user-email").textContent = s.user.email;
      showApp();
      clearUrlToken();
      loadAll();
    } else if (!window.location.hash && !window.location.search) {
      showAuth();
    }
  }
  queueMicrotask(earlyBoot);

  setTimeout(() => {
    if ($("auth-screen").classList.contains("hidden") && $("app").classList.contains("hidden")) {
      showAuth();
      $("auth-msg").className = "auth-msg err";
      $("auth-msg").textContent = "Taking longer than usual to connect — check your connection and reload.";
    }
  }, 8000);

  /* ---------------- DATA ---------------- */
  function sessionFromStorage() {
    try {
      const raw = (window.localStorage && window.localStorage.getItem(SB_STORAGE_KEY)) || null;
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && o.access_token ? o : (o && o.currentSession) || null;
    } catch (_) { return null; }
  }

  async function rest(path) {
    const res = await fetch(cfg.SUPABASE_URL + "/rest/v1/" + path, {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + (accessToken || cfg.SUPABASE_ANON_KEY),
      },
    });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res.json();
  }

  // PATCH/POST/DELETE helper with auth header (mirrors rest()).
  async function restWrite(path, method, body) {
    const res = await fetch(cfg.SUPABASE_URL + "/rest/v1/" + path, {
      method,
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + (accessToken || cfg.SUPABASE_ANON_KEY),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res;
  }

  // Load the people directory + the signed-in user's aliases/prefs/admin flag in one go.
  // Error-safe: if newer columns (aliases/prefs/is_admin) aren't migrated yet, falls back.
  async function loadProfiles() {
    if (!currentUserId) return;
    try {
      directory = await rest("profiles?select=id,full_name,email,aliases,is_admin,prefs&order=full_name.asc");
    } catch (_) {
      try { directory = await rest("profiles?select=id,full_name,email,aliases&order=full_name.asc"); }
      catch (_2) { directory = []; }
    }
    profileById = {};
    directory.forEach((p) => { profileById[p.id] = p; });
    const me = profileById[currentUserId] || {};
    isAdmin = !!me.is_admin;
    myPrefs = me.prefs || {};
    myAliases = [...new Set([
      ...((me.aliases || []).map((a) => String(a).trim().toLowerCase())),
      (me.full_name || "").toLowerCase(),
      (me.email || "").toLowerCase(),
    ].filter(Boolean))];
    applyPrefs();
    render();
  }

  function applyPrefs() {
    document.documentElement.setAttribute("data-theme", myPrefs.theme === "light" ? "light" : "dark");
    if (prefsApplied) return;   // view/filter only on first load, not on every refresh
    prefsApplied = true;
    if (myPrefs.view && ["board", "list", "graph", "team"].includes(myPrefs.view)) {
      currentView = myPrefs.view;
      document.querySelectorAll(".view-tab").forEach((t) =>
        t.classList.toggle("active", t.dataset.view === currentView));
    }
    if (myPrefs.filter === "mine" && myAliases.length) {
      filters.mine = true;
      $("mine-toggle").classList.add("btn-primary");
      $("mine-toggle").classList.remove("btn-ghost");
    }
  }

  let loadingNow = false;
  let reloadQueued = false;
  async function loadAll() {
    if (loadingNow) { reloadQueued = true; return; }
    loadingNow = true;
    try {
      const [pj, tk] = await Promise.race([
        Promise.all([
          rest("projects?select=*&archived=eq.false&order=created_at.asc"),
          rest("tasks?select=*&order=deadline.asc.nullslast"),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Load timed out")), 12000)),
      ]);
      projects = pj || [];
      tasks = tk || [];
      refreshFilters();
      render();
      startRealtime();
      loadProfiles();   // directory + aliases + prefs + admin (non-blocking)
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        try { await sb.auth.signOut({ scope: "local" }); } catch (_) {}
        showAuth();
        return;
      }
      toast("Couldn't load the board — retrying…");
      setTimeout(() => { if (currentUserId) loadAll(); }, 3000);
    } finally {
      loadingNow = false;
      if (reloadQueued) { reloadQueued = false; loadAll(); }
    }
  }

  let realtimeStarted = false;
  function startRealtime() {
    if (realtimeStarted) return;
    realtimeStarted = true;
    sb.channel("rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, (payload) => {
        const tid = (payload.new && payload.new.task_id) || (payload.old && payload.old.task_id);
        if (openTaskId && tid === openTaskId) loadComments(openTaskId);
      })
      .subscribe();
  }

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
      if (t.archived) return;
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
      if (t.archived) return false;   // soft-deleted tasks are hidden (column may not exist → undefined → shown)
      if (filters.mine) {
        const lc = (t.assignees || []).map((a) => String(a).toLowerCase());
        if (!myAliases.some((a) => lc.includes(a))) return false;
      }
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

  $("mine-toggle").addEventListener("click", () => {
    if (!myAliases.length) { openProfile(); return; }
    filters.mine = !filters.mine;
    $("mine-toggle").classList.toggle("btn-primary", filters.mine);
    $("mine-toggle").classList.toggle("btn-ghost", !filters.mine);
    render();
  });

  /* ---------------- SETTINGS (names + preferences) ---------------- */
  function openProfile() {
    $("alias-input").value = ((profileById[currentUserId] || {}).aliases || []).join(", ");
    $("pref-view").value = myPrefs.view || "board";
    $("pref-filter").value = myPrefs.filter || "";
    $("pref-theme").value = myPrefs.theme || "dark";
    $("profile-modal").classList.remove("hidden");
  }
  $("my-names-btn").addEventListener("click", openProfile);

  // Live theme preview while the modal is open.
  $("pref-theme").addEventListener("change", (e) =>
    document.documentElement.setAttribute("data-theme", e.target.value === "light" ? "light" : "dark"));

  $("profile-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const aliases = splitList($("alias-input").value);
    const prefs = {
      view: $("pref-view").value,
      filter: $("pref-filter").value,
      theme: $("pref-theme").value,
    };
    closeModals();
    try {
      await restWrite("profiles?id=eq." + currentUserId, "PATCH", { aliases, prefs });
      myPrefs = prefs;
      myAliases = [...new Set([
        ...aliases.map((a) => a.toLowerCase()),
        ((profileById[currentUserId] || {}).full_name || "").toLowerCase(),
        ((profileById[currentUserId] || {}).email || "").toLowerCase(),
      ].filter(Boolean))];
      if (profileById[currentUserId]) { profileById[currentUserId].aliases = aliases; profileById[currentUserId].prefs = prefs; }
      document.documentElement.setAttribute("data-theme", prefs.theme === "light" ? "light" : "dark");
      toast("Settings saved");
      render();
    } catch (err) {
      toast("Couldn't save — has migrate-features.sql been run? (" + (err.message || err) + ")");
    }
  });

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
    $("team-view").classList.toggle("hidden", v !== "team");
    if (v === "board") renderBoard();
    else if (v === "list") renderList();
    else if (v === "graph") renderGraph();
    else if (v === "team") renderTeam();
  }

  function renderGraph() {
    if (!window.SynapseGraph) return;
    if (!graphInst) {
      graphInst = window.SynapseGraph.mount($("graph-view"), {
        getProjects: () => projects,
        getTasks: () => visibleTasks(),
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

  function nameFor(uuid) {
    if (!uuid) return "";
    const p = profileById[uuid];
    return p ? (p.full_name || p.email || "Unknown") : "Unknown";
  }

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

    board.querySelectorAll(".card").forEach((c) =>
      c.addEventListener("click", () => openTask(c.dataset.id)));

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
    const by = t.created_by ? nameFor(t.created_by) : "";
    return `<div class="card ${late ? "overdue" : ""}" data-id="${t.id}">
      ${p ? `<div class="card-proj"><span class="col-dot" style="background:${p.color}"></span>${esc(p.name)}</div>` : ""}
      <div class="card-title">${esc(t.title)}</div>
      ${(t.tags && t.tags.length) ? `<div class="chips">${t.tags.map((x)=>`<span class="chip tag">${esc(x)}</span>`).join("")}</div>` : ""}
      <div class="card-meta">
        <span class="pill pri-${t.priority || "medium"}">${t.priority || "medium"}</span>
        ${t.deadline ? `<span class="due ${late ? "late" : ""}">${fmtDate(t.deadline)}</span>` : ""}
        ${people.length ? `<span class="avatars">${people.map((a)=>`<span class="avatar" title="${esc(a)}">${initials(a)}</span>`).join("")}</span>` : ""}
      </div>
      ${by ? `<div class="card-by muted small">by ${esc(by)}</div>` : ""}
    </div>`;
  }

  function renderList() {
    const list = visibleTasks().slice().sort((a, b) =>
      (a.deadline || "9999").localeCompare(b.deadline || "9999"));
    const v = $("list-view");
    if (!list.length) { v.innerHTML = '<div class="empty">No tasks match your filters.</div>'; return; }
    v.innerHTML = `<table><thead><tr>
        <th>Task</th><th>Project</th><th>Status</th><th>Priority</th>
        <th>Deadline</th><th>People</th><th>Tags</th><th>Created by</th>
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
          <td>${t.created_by ? esc(nameFor(t.created_by)) : "—"}</td>
        </tr>`;
      }).join("")}</tbody></table>`;
    v.querySelectorAll("tr[data-id]").forEach((r) =>
      r.addEventListener("click", () => openTask(r.dataset.id)));
  }

  /* ---------------- TEAM / WORKLOAD VIEW ---------------- */
  function aggregateWorkload() {
    const canon = {};   // lower-cased alias/name -> canonical display name
    directory.forEach((p) => {
      const disp = p.full_name || p.email;
      if (!disp) return;
      canon[disp.toLowerCase()] = disp;
      (p.aliases || []).forEach((a) => { if (a) canon[String(a).toLowerCase()] = disp; });
    });
    const counts = {};
    tasks.forEach((t) => {
      if (t.archived || t.status === "done") return;
      (t.assignees || []).forEach((raw) => {
        const key = String(raw).trim();
        if (!key) return;
        const disp = canon[key.toLowerCase()] || key;
        counts[disp] = (counts[disp] || 0) + 1;
      });
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function renderTeam() {
    const rows = aggregateWorkload();
    const v = $("team-view");
    if (!rows.length) { v.innerHTML = '<div class="empty">No open tasks to show.</div>'; return; }
    const max = rows[0][1] || 1;
    v.innerHTML = `<div class="workload">
      <div class="workload-title">Open tasks per person</div>
      ${rows.map(([name, n]) => `
        <div class="workload-row" data-person="${esc(name)}">
          <span class="workload-name">${esc(name)}</span>
          <span class="workload-bar"><span class="workload-fill" style="width:${(n / max * 100).toFixed(0)}%"></span></span>
          <span class="workload-count">${n}</span>
        </div>`).join("")}
    </div>`;
    v.querySelectorAll(".workload-row").forEach((r) =>
      r.addEventListener("click", () => {
        filters.assignee = r.dataset.person;
        currentView = "board";
        document.querySelectorAll(".view-tab").forEach((t) =>
          t.classList.toggle("active", t.dataset.view === "board"));
        $("filter-assignee").value = r.dataset.person;
        render();
      }));
  }

  /* ---------------- ASSIGNEE PICKER ---------------- */
  function mountPicker(root) {
    let values = [];
    const chipsRow = root.querySelector(".chips-row");
    const input = root.querySelector(".picker-input");
    const menu = root.querySelector(".picker-menu");

    function isKnown(name) {
      const lc = name.toLowerCase();
      return directory.some((p) =>
        (p.full_name || "").toLowerCase() === lc || (p.email || "").toLowerCase() === lc);
    }
    function renderChips() {
      chipsRow.innerHTML = values.map((v, i) =>
        `<span class="chip-pick${isKnown(v) ? "" : " chip-adhoc"}">${esc(v)}<button type="button" class="chip-x" data-i="${i}">×</button></span>`
      ).join("");
      chipsRow.querySelectorAll(".chip-x").forEach((b) =>
        b.addEventListener("click", () => { values.splice(+b.dataset.i, 1); renderChips(); }));
    }
    function add(name) {
      const v = String(name).trim();
      if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) values.push(v);
      input.value = ""; menu.classList.add("hidden"); renderChips();
    }
    function showMenu() {
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      const chosen = new Set(values.map((v) => v.toLowerCase()));
      const hits = directory.filter((p) => {
        if (chosen.has((p.full_name || "").toLowerCase())) return false;
        const hay = [p.full_name, p.email, ...(p.aliases || [])].join(" ").toLowerCase();
        return q ? hay.includes(q) : true;
      }).slice(0, 8);
      let html = hits.map((p) =>
        `<div class="picker-opt" data-name="${esc(p.full_name || p.email)}">${esc(p.full_name || p.email)}<span class="muted small"> ${esc(p.email || "")}</span></div>`).join("");
      if (raw && !hits.some((p) => (p.full_name || "").toLowerCase() === q))
        html += `<div class="picker-opt picker-add" data-name="${esc(raw)}">Add “${esc(raw)}”</div>`;
      if (!html) { menu.classList.add("hidden"); return; }
      menu.innerHTML = html;
      menu.classList.remove("hidden");
      menu.querySelectorAll(".picker-opt").forEach((o) =>
        o.addEventListener("mousedown", (ev) => { ev.preventDefault(); add(o.dataset.name); input.focus(); }));
    }
    input.addEventListener("input", showMenu);
    input.addEventListener("focus", showMenu);
    input.addEventListener("blur", () => setTimeout(() => menu.classList.add("hidden"), 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (input.value.trim()) add(input.value); }
      else if (e.key === "Backspace" && !input.value && values.length) { values.pop(); renderChips(); }
      else if (e.key === "Escape" && !menu.classList.contains("hidden")) { e.stopPropagation(); menu.classList.add("hidden"); }
    });
    return {
      getValues: () => values.slice(),
      setValues: (arr) => { values = (arr || []).slice(); input.value = ""; menu.classList.add("hidden"); renderChips(); },
    };
  }
  const pickAssignees = mountPicker($("pick-assignees"));
  const pickStakeholders = mountPicker($("pick-stakeholders"));

  /* ---------------- TASK MODAL ---------------- */
  function fillProjectSelect() {
    $("f-project").innerHTML = '<option value="">— none —</option>' +
      projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  }

  function openTask(id) {
    fillProjectSelect();
    const t = tasks.find((x) => x.id === id);
    openTaskId = t ? t.id : null;
    $("task-modal-title").textContent = t ? "Edit task" : "New task";
    $("task-id").value = t ? t.id : "";
    $("f-title").value = t ? t.title : "";
    $("f-description").value = t ? (t.description || "") : "";
    $("f-project").value = t ? (t.project_id || "") : (filters.project || "");
    $("f-status").value = t ? t.status : "todo";
    $("f-priority").value = t ? (t.priority || "medium") : "medium";
    $("f-deadline").value = t ? (t.deadline || "") : "";
    pickAssignees.setValues(t ? (t.assignees || []) : []);
    pickStakeholders.setValues(t ? (t.stakeholders || []) : []);
    $("f-tags").value = t ? (t.tags || []).join(", ") : "";
    // delete controls: archive available on existing tasks; hard delete for creator/admin
    $("delete-task-btn").classList.toggle("hidden", !t);
    const canHard = t && (isAdmin || t.created_by === currentUserId);
    $("hard-delete-task-btn").classList.toggle("hidden", !canHard);
    $("task-updated-by").textContent = (t && t.updated_by) ? "Last updated by " + nameFor(t.updated_by) : "";
    // comments
    const cbox = $("task-comments");
    if (t) { cbox.classList.remove("hidden"); $("comment-input").value = ""; loadComments(t.id); }
    else { cbox.classList.add("hidden"); commentsCache = []; $("comment-list").innerHTML = ""; }
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
      assignees: pickAssignees.getValues(),
      stakeholders: pickStakeholders.getValues(),
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

  // Soft delete (archive) — available to any signed-in user; recoverable.
  $("delete-task-btn").addEventListener("click", async () => {
    const id = $("task-id").value;
    if (!id || !confirm("Remove this task? It will be archived (recoverable by an admin).")) return;
    closeModals();
    await updateTask(id, { archived: true });
    toast("Task archived");
    await loadAll();
  });

  // Hard delete — RLS allows only the creator or an admin.
  $("hard-delete-task-btn").addEventListener("click", async () => {
    const id = $("task-id").value;
    if (!id || !confirm("Permanently delete this task? This cannot be undone.")) return;
    closeModals();
    const { error } = await sb.from("tasks").delete().eq("id", id);
    if (error) {
      toast(/permission|row-level|403/i.test(error.message || "")
        ? "Only the creator or an admin can permanently delete this task."
        : "Error: " + error.message);
    } else { toast("Task deleted"); }
    await loadAll();
  });

  async function updateTask(id, patch) {
    const { error } = await sb.from("tasks").update({ ...patch, updated_by: currentUserId }).eq("id", id);
    if (error) toast("Error: " + error.message);
  }

  /* ---------------- COMMENTS ---------------- */
  async function loadComments(taskId) {
    try {
      commentsCache = await rest("comments?select=*&task_id=eq." + taskId + "&order=created_at.asc");
    } catch (_) { commentsCache = []; }
    renderComments();
  }

  function renderComments() {
    const box = $("comment-list");
    if (!commentsCache.length) { box.innerHTML = '<div class="empty">No comments yet.</div>'; return; }
    box.innerHTML = commentsCache.map((c) => `
      <div class="comment" data-id="${c.id}">
        <div class="comment-head">
          <span class="avatar">${initials(nameFor(c.author_id) || "?")}</span>
          <b>${esc(nameFor(c.author_id) || "Someone")}</b>
          <span class="muted small">${relTime(c.created_at)}</span>
          ${(c.author_id === currentUserId || isAdmin) ? '<button class="comment-del" title="Delete">×</button>' : ""}
        </div>
        <div class="comment-body">${renderBody(c.body)}</div>
      </div>`).join("");
    box.querySelectorAll(".comment-del").forEach((b) =>
      b.addEventListener("click", () => deleteComment(b.closest(".comment").dataset.id)));
    box.scrollTop = box.scrollHeight;
  }

  function renderBody(s) {
    return esc(s).replace(/@([\w.\-]+(?: [\w.\-]+)?)/g, '<span class="mention">@$1</span>');
  }

  function extractMentions(body) {
    const lc = body.toLowerCase();
    const ids = new Set();
    directory.forEach((p) => {
      const names = [p.full_name, ...(p.aliases || [])].filter(Boolean);
      if (names.some((n) => lc.includes("@" + String(n).toLowerCase()))) ids.add(p.id);
    });
    return [...ids];
  }

  // @mention autocomplete
  function currentMentionQuery(el) {
    const upto = el.value.slice(0, el.selectionStart);
    const m = upto.match(/@([\w.\- ]{0,30})$/);
    return m ? m[1] : null;
  }
  $("comment-input").addEventListener("input", (e) => {
    const q = currentMentionQuery(e.target);
    const menu = $("mention-menu");
    if (q == null) { menu.classList.add("hidden"); return; }
    const ql = q.trim().toLowerCase();
    const hits = directory.filter((p) => {
      const hay = [p.full_name, p.email, ...(p.aliases || [])].join(" ").toLowerCase();
      return !ql || hay.includes(ql);
    }).slice(0, 6);
    if (!hits.length) { menu.classList.add("hidden"); return; }
    menu.innerHTML = hits.map((p) =>
      `<div class="mention-item" data-name="${esc(p.full_name || p.email)}">${esc(p.full_name || p.email)}<span class="muted small"> ${esc(p.email || "")}</span></div>`).join("");
    menu.classList.remove("hidden");
    menu.querySelectorAll(".mention-item").forEach((it) =>
      it.addEventListener("mousedown", (ev) => { ev.preventDefault(); insertMention(e.target, it.dataset.name); menu.classList.add("hidden"); }));
  });
  function insertMention(el, name) {
    const head = el.value.slice(0, el.selectionStart).replace(/@([\w.\- ]{0,30})$/, "@" + name + " ");
    const tail = el.value.slice(el.selectionStart);
    el.value = head + tail;
    el.focus();
    el.selectionStart = el.selectionEnd = head.length;
  }

  $("comment-send").addEventListener("click", sendComment);
  $("comment-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(); }
  });

  async function sendComment() {
    const body = $("comment-input").value.trim();
    if (!body || !openTaskId) return;
    try {
      await restWrite("comments", "POST", {
        task_id: openTaskId, author_id: currentUserId, body, mentions: extractMentions(body),
      });
      $("comment-input").value = "";
      loadComments(openTaskId);
    } catch (err) {
      toast("Couldn't post comment — has migrate-features.sql been run? (" + (err.message || err) + ")");
    }
  }

  async function deleteComment(id) {
    if (!confirm("Delete this comment?")) return;
    try {
      await restWrite("comments?id=eq." + id, "DELETE");
      loadComments(openTaskId);
    } catch (err) { toast("Couldn't delete: " + (err.message || err)); }
  }

  /* ---------------- PROJECTS MODAL ---------------- */
  $("manage-projects-btn").addEventListener("click", () => { renderProjectList(); $("project-modal").classList.remove("hidden"); });

  function renderProjectList() {
    $("project-list").innerHTML = projects.length
      ? projects.map((p) => {
          const canArchive = isAdmin || p.created_by === currentUserId;
          return `<div class="project-row" data-id="${p.id}">
            <span class="col-dot" style="background:${p.color}"></span>
            <span class="pname">${esc(p.name)}</span>
            ${p.created_by ? `<span class="muted small">by ${esc(nameFor(p.created_by))}</span>` : ""}
            ${canArchive ? `<button class="btn btn-danger btn-sm" data-del="${p.id}">Archive</button>` : ""}
          </div>`;
        }).join("")
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
    const p = String(name).trim().split(/\s+/);
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
  function relTime(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
})();
