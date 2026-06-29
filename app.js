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
      "⚠️ Not connected yet. Open <b>config.js</b> and paste your Supabase URL and anon key (see SETUP.md).";
    $("login-form").style.display = "none";
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      flowType: "implicit",      // token in the link — works across devices/browsers
      detectSessionInUrl: true,  // process the token when the link lands
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  // In-memory state
  let projects = [];
  let tasks = [];
  let currentView = "board";
  const filters = { search: "", project: "", assignee: "", tag: "" };

  /* ---------------- AUTH ---------------- */
  function showAuth() { $("auth-screen").classList.remove("hidden"); $("app").classList.add("hidden"); }
  function showApp()  { $("auth-screen").classList.add("hidden"); $("app").classList.remove("hidden"); }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    const msg = $("auth-msg");
    msg.className = "auth-msg";
    msg.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    if (error) { msg.className = "auth-msg err"; msg.textContent = error.message; }
    else { msg.className = "auth-msg ok"; msg.textContent = "✅ Check your email for the sign-in link."; }
  });

  $("signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); });

  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session && session.user) {
      $("user-email").textContent = session.user.email;
      showApp();
      await loadAll();
    } else {
      showAuth();
    }
  });

  // Handle initial session (e.g. returning from magic link)
  sb.auth.getSession().then(({ data }) => {
    if (data.session) {
      $("user-email").textContent = data.session.user.email;
      showApp();
      loadAll();
    } else {
      showAuth();
    }
  });

  /* ---------------- DATA ---------------- */
  async function loadAll() {
    const [{ data: pj }, { data: tk }] = await Promise.all([
      sb.from("projects").select("*").eq("archived", false).order("created_at"),
      sb.from("tasks").select("*").order("deadline", { nullsFirst: false }),
    ]);
    projects = pj || [];
    tasks = tk || [];
    refreshFilters();
    render();
  }

  // Live updates so consultants see each other's changes
  sb.channel("rt")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, loadAll)
    .subscribe();

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
    if (currentView === "board") {
      $("board-view").classList.remove("hidden");
      $("list-view").classList.add("hidden");
      renderBoard();
    } else {
      $("board-view").classList.add("hidden");
      $("list-view").classList.remove("hidden");
      renderList();
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
        ${t.deadline ? `<span class="due ${late ? "late" : ""}">📅 ${fmtDate(t.deadline)}</span>` : ""}
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
    if (id) await updateTask(id, payload);
    else {
      const { data: u } = await sb.auth.getUser();
      payload.created_by = u.user.id;
      const { error } = await sb.from("tasks").insert(payload);
      if (error) return toast("Error: " + error.message);
      toast("Task added");
    }
    await loadAll();
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
    const { data: u } = await sb.auth.getUser();
    const { error } = await sb.from("projects").insert({
      name, color: $("p-color").value, created_by: u.user.id,
    });
    if (error) return toast("Error: " + error.message);
    $("p-name").value = "";
    await loadAll(); renderProjectList();
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
