/* ============================================================
   Synapse Graph — Obsidian-style project graph for the tracker.
   Connects projects by SHARED PEOPLE and SHARED TAGS (derived
   from existing task data — no schema changes). Force-directed
   layout, draggable nodes, click-to-inspect.

   Usage:
     const inst = SynapseGraph.mount(container, {
       getProjects, getTasks, statuses, openProject
     });
     inst.update();   // re-render after data changes
   ============================================================ */
(function () {
  "use strict";
  const W = 1160, H = 640;
  const TAG_COLOR = "#34b3c7";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.SynapseGraph = {
    mount(container, api) {
      const pos = {}, vel = {};
      let nodes = [], visEdges = [], structEdges = [];
      let sel = null, dragId = null, off = null, moved = false;
      let raf = null, running = false, arranged = false;
      let showPeople = true, showTags = true;

      container.innerHTML =
        '<div class="graph-canvas">' +
          '<svg class="graph-edges" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"></svg>' +
          '<div class="graph-nodes"></div>' +
          '<div class="graph-head">' +
            '<div class="graph-title">Project Graph<span class="graph-sub">drag to arrange · click to inspect</span></div>' +
            '<div class="graph-filters">' +
              '<button class="gfilter on" data-f="people"><i class="ln solid"></i>Shared people</button>' +
              '<button class="gfilter on" data-f="tags"><i class="ln dash"></i>Shared tags</button>' +
              '<button class="gbtn" data-arrange>&#8635; Auto-arrange</button>' +
            '</div>' +
          '</div>' +
          '<div class="graph-empty hidden">No projects to graph yet.</div>' +
          '<div class="graph-panel hidden"></div>' +
        '</div>';

      const canvas = container.querySelector(".graph-canvas");
      const svg = container.querySelector(".graph-edges");
      const nodeLayer = container.querySelector(".graph-nodes");
      const panel = container.querySelector(".graph-panel");
      const emptyEl = container.querySelector(".graph-empty");

      container.querySelectorAll(".gfilter").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.dataset.f === "people") showPeople = !showPeople; else showTags = !showTags;
          b.classList.toggle("on");
          compute(); buildEdges(); position(); highlight();
        }));
      container.querySelector("[data-arrange]").addEventListener("click", () => startLayout());

      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseup", onUp);
      canvas.addEventListener("mouseleave", onUp);

      /* -------- data -------- */
      function compute() {
        const projects = (api.getProjects() || []);
        const tasks = (api.getTasks() || []);
        const agg = {};
        projects.forEach((p) => agg[p.id] = { people: new Set(), tags: new Set(), total: 0, blocked: 0, done: 0, inprog: 0 });
        tasks.forEach((t) => {
          const a = agg[t.project_id]; if (!a) return;
          a.total++;
          if (t.status === "blocked") a.blocked++;
          else if (t.status === "done") a.done++;
          else if (t.status === "in_progress") a.inprog++;
          (t.assignees || []).forEach((x) => a.people.add(x));
          (t.stakeholders || []).forEach((x) => a.people.add(x));
          (t.tags || []).forEach((x) => a.tags.add(x));
        });
        nodes = projects.map((p) => Object.assign({ id: p.id, name: p.name, color: p.color || "#9d9da6" }, agg[p.id]));

        const cx = W / 2, cy = H / 2, R = 200;
        nodes.forEach((n, i) => {
          if (!pos[n.id]) {
            const ang = (i / Math.max(1, nodes.length)) * Math.PI * 2;
            pos[n.id] = { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R };
          }
          if (!vel[n.id]) vel[n.id] = { x: 0, y: 0, fx: 0, fy: 0 };
        });
        Object.keys(pos).forEach((id) => { if (!nodes.find((n) => n.id === id)) { delete pos[id]; delete vel[id]; } });
        if (sel && !nodes.find((n) => n.id === sel)) sel = null;

        visEdges = []; structEdges = [];
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const A = nodes[i], B = nodes[j];
          const sp = [...A.people].filter((x) => B.people.has(x));
          const st = [...A.tags].filter((x) => B.tags.has(x));
          if (sp.length || st.length) structEdges.push([A.id, B.id]);
          if (showPeople && sp.length) visEdges.push({ a: A.id, b: B.id, type: "people", shared: sp });
          if (showTags && st.length) visEdges.push({ a: A.id, b: B.id, type: "tag", shared: st });
        }
        emptyEl.classList.toggle("hidden", nodes.length > 0);
      }

      function neighborSet() {
        const set = new Set();
        visEdges.forEach((e) => { if (e.a === sel) set.add(e.b); if (e.b === sel) set.add(e.a); });
        return set;
      }

      /* -------- build DOM -------- */
      function buildNodes() {
        nodeLayer.innerHTML = "";
        nodes.forEach((n) => {
          const el = document.createElement("div");
          el.className = "gnode";
          el.dataset.id = n.id;
          const flags = (n.blocked ? '<span class="gflag block" title="blocked tasks">' + n.blocked + '</span>' : "");
          el.innerHTML =
            '<div class="gnode-card">' +
              '<span class="gdot" style="background:' + esc(n.color) + '"></span>' +
              '<span class="gname">' + esc(n.name) + '</span>' +
              '<span class="gcount">' + n.done + "/" + n.total + '</span>' + flags +
            '</div>';
          el.addEventListener("mousedown", (e) => onDown(n.id, e));
          n.el = el;
          nodeLayer.appendChild(el);
        });
      }

      function buildEdges() {
        svg.innerHTML = "";
        visEdges.forEach((e) => {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", e.type === "people" ? "var(--primary)" : TAG_COLOR);
          path.setAttribute("stroke-linecap", "round");
          if (e.type === "tag") path.setAttribute("stroke-dasharray", "6 6");
          e.el = path;
          svg.appendChild(path);
        });
      }

      /* -------- positioning -------- */
      function position() {
        const nb = sel ? neighborSet() : null;
        nodes.forEach((n) => {
          const p = pos[n.id]; if (!n.el || !p) return;
          n.el.style.left = (p.x / W * 100) + "%";
          n.el.style.top = (p.y / H * 100) + "%";
        });
        visEdges.forEach((e) => {
          const a = pos[e.a], b = pos[e.b]; if (!e.el || !a || !b) return;
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const sx = a.x + ux * 22, sy = a.y + uy * 22, ex = b.x - ux * 22, ey = b.y - uy * 22;
          const sign = e.type === "people" ? 1 : -1;
          const mx = (sx + ex) / 2 - uy * 34 * sign, my = (sy + ey) / 2 + ux * 34 * sign;
          e.el.setAttribute("d", "M " + sx + " " + sy + " Q " + mx + " " + my + " " + ex + " " + ey);
          const involved = sel && (e.a === sel || e.b === sel);
          e.el.setAttribute("stroke-width", involved ? 2.6 : 1.7);
          e.el.setAttribute("stroke-opacity", sel ? (involved ? 1 : 0.12) : 0.6);
        });
      }

      function highlight() {
        const nb = sel ? neighborSet() : null;
        nodes.forEach((n) => {
          if (!n.el) return;
          const isSel = n.id === sel;
          const active = !sel || isSel || (nb && nb.has(n.id));
          n.el.classList.toggle("sel", isSel);
          n.el.classList.toggle("dim", !!sel && !active);
        });
        renderPanel();
      }

      /* -------- panel -------- */
      function renderPanel() {
        if (!sel) { panel.classList.add("hidden"); return; }
        const n = nodes.find((x) => x.id === sel); if (!n) { panel.classList.add("hidden"); return; }
        const conns = [];
        structEdges.forEach((pair) => {
          let other = null;
          if (pair[0] === sel) other = pair[1]; else if (pair[1] === sel) other = pair[0];
          if (!other) return;
          const on = nodes.find((x) => x.id === other); if (!on) return;
          const sp = [...n.people].filter((x) => on.people.has(x));
          const st = [...n.tags].filter((x) => on.tags.has(x));
          conns.push({ id: other, name: on.name, color: on.color, people: sp, tags: st });
        });
        const chip = (arr, cls) => arr.map((x) => '<span class="gchip ' + cls + '">' + esc(x) + "</span>").join("");
        panel.innerHTML =
          '<div class="gpanel-head"><span class="gdot" style="background:' + esc(n.color) + '"></span>' +
            '<div class="gpanel-name">' + esc(n.name) + '</div>' +
            '<button class="gpanel-x" title="close">&times;</button></div>' +
          '<div class="gpanel-stats">' +
            '<div><b>' + n.total + '</b><span>tasks</span></div>' +
            '<div><b>' + n.inprog + '</b><span>active</span></div>' +
            '<div><b class="' + (n.blocked ? "warn" : "") + '">' + n.blocked + '</b><span>blocked</span></div>' +
            '<div><b>' + n.done + '</b><span>done</span></div>' +
          '</div>' +
          (n.people.size ? '<div class="gpanel-sec"><div class="gpanel-label">PEOPLE</div><div class="gchips">' + chip([...n.people], "p") + '</div></div>' : "") +
          (n.tags.size ? '<div class="gpanel-sec"><div class="gpanel-label">TAGS</div><div class="gchips">' + chip([...n.tags], "t") + '</div></div>' : "") +
          '<div class="gpanel-sec"><div class="gpanel-label">CONNECTED PROJECTS</div>' +
            (conns.length ? conns.map((c) =>
              '<button class="gconn" data-open="' + c.id + '">' +
                '<span class="gdot" style="background:' + esc(c.color) + '"></span>' +
                '<span class="gconn-name">' + esc(c.name) + '</span>' +
                '<span class="gconn-meta">' + (c.people.length ? c.people.length + "p" : "") + (c.people.length && c.tags.length ? " · " : "") + (c.tags.length ? c.tags.length + "t" : "") + '</span>' +
              '</button>').join("")
              : '<div class="gpanel-none">No shared people or tags</div>') +
          '</div>' +
          '<button class="gpanel-open" data-board="' + n.id + '">View tasks in board →</button>';

        panel.classList.remove("hidden");
        panel.querySelector(".gpanel-x").addEventListener("click", () => { sel = null; position(); highlight(); });
        panel.querySelectorAll("[data-open]").forEach((b) =>
          b.addEventListener("click", () => { sel = b.dataset.open; position(); highlight(); }));
        const openBtn = panel.querySelector("[data-board]");
        if (openBtn) openBtn.addEventListener("click", () => api.openProject && api.openProject(openBtn.dataset.board));
      }

      /* -------- drag -------- */
      function onDown(id, e) {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const sx = W / r.width, sy = H / r.height, p = pos[id];
        off = { dx: (e.clientX - r.left) * sx - p.x, dy: (e.clientY - r.top) * sy - p.y };
        moved = false; dragId = id; running = false;
        if (raf) cancelAnimationFrame(raf);
      }
      function onMove(e) {
        if (!dragId) return;
        const r = canvas.getBoundingClientRect();
        const sx = W / r.width, sy = H / r.height;
        let x = (e.clientX - r.left) * sx - off.dx;
        let y = (e.clientY - r.top) * sy - off.dy;
        x = Math.max(95, Math.min(W - 95, x));
        y = Math.max(80, Math.min(H - 70, y));
        pos[dragId] = { x, y }; moved = true; position();
      }
      function onUp() {
        if (!dragId) return;
        const id = dragId; dragId = null;
        if (!moved) { sel = (sel === id ? null : id); position(); highlight(); }
      }

      /* -------- force layout -------- */
      function startLayout() {
        if (!nodes.length) return;
        if (raf) cancelAnimationFrame(raf);
        nodes.forEach((n) => vel[n.id] = { x: 0, y: 0, fx: 0, fy: 0 });
        let ticks = 0; running = true;
        const run = () => { tick(); if (++ticks < 200 && running) raf = requestAnimationFrame(run); else running = false; };
        raf = requestAnimationFrame(run);
      }
      function tick() {
        const cx = W / 2, cy = H / 2;
        const ids = nodes.map((n) => n.id);
        const REP = 95000, SPRING = 0.018, LEN = 250, CENTER = 0.009, DAMP = 0.82;
        ids.forEach((id) => { vel[id].fx = (cx - pos[id].x) * CENTER; vel[id].fy = (cy - pos[id].y) * CENTER; });
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const a = pos[ids[i]], b = pos[ids[j]];
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
          const d = Math.sqrt(d2), f = REP / d2, ux = dx / d, uy = dy / d;
          vel[ids[i]].fx += ux * f; vel[ids[i]].fy += uy * f;
          vel[ids[j]].fx -= ux * f; vel[ids[j]].fy -= uy * f;
        }
        structEdges.forEach((pair) => {
          const a = pos[pair[0]], b = pos[pair[1]]; if (!a || !b) return;
          let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
          const f = SPRING * (d - LEN), ux = dx / d, uy = dy / d;
          vel[pair[0]].fx += ux * f; vel[pair[0]].fy += uy * f;
          vel[pair[1]].fx -= ux * f; vel[pair[1]].fy -= uy * f;
        });
        let energy = 0;
        ids.forEach((id) => {
          if (id === dragId) { vel[id].x = 0; vel[id].y = 0; return; }
          vel[id].x = (vel[id].x + vel[id].fx) * DAMP;
          vel[id].y = (vel[id].y + vel[id].fy) * DAMP;
          pos[id] = {
            x: Math.max(95, Math.min(W - 95, pos[id].x + vel[id].x)),
            y: Math.max(80, Math.min(H - 70, pos[id].y + vel[id].y)),
          };
          energy += Math.abs(vel[id].x) + Math.abs(vel[id].y);
        });
        position();
        if (energy < 0.5) running = false;
      }

      /* -------- public update -------- */
      function update() {
        compute(); buildNodes(); buildEdges(); position(); highlight();
        if (!arranged && nodes.length) { arranged = true; startLayout(); }
      }

      update();
      return { update };
    },
  };
})();
