// cue-note IDE-style UI. Dependency-free vanilla JS.
// Talks to same-origin /api/... (the webui proxy maps /api/* to the API's
// /v1/* routes and injects the API key).
// Feature-detects the v2 API (categories, kind, systemPromptId, promptId);
// degrades to a tag-grouped tree against the v1 API. `?mock=1` serves
// in-memory sample data so the full v2 UX is demonstrable without a backend.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    apiMode: "detecting", // "v2" | "v1" | "mock" | "offline"
    prompts: [],
    notes: [],
    categories: [],
    tags: [],
    search: "",
    kindFilter: "", // "" | "system" | "user" | "notes"
    tagFilter: null,
    collapsed: new Set(JSON.parse(localStorage.getItem("cuenote.collapsed") || "[]")),
    tabs: [], // { key, type: "prompt"|"note", id|null, draft, dirty, viewMode }
    activeTab: null,
    loading: true,
  };

  const saveCollapsed = () =>
    localStorage.setItem("cuenote.collapsed", JSON.stringify([...state.collapsed]));

  // ------------------------------------------------------------------
  // Mock backend (?mock=1)
  // ------------------------------------------------------------------
  const useMock = new URLSearchParams(location.search).get("mock") === "1";

  const mock = (() => {
    let seq = 0;
    const id = () => (Date.now() + seq++).toString(16) + Math.floor(Math.random() * 0xffff).toString(16);
    const now = () => new Date().toISOString();
    const cats = [
      { id: "c-agents", name: "Agents", parentId: "" },
      { id: "c-coding", name: "Coding", parentId: "c-agents" },
      { id: "c-research", name: "Research", parentId: "c-agents" },
      { id: "c-writing", name: "Writing", parentId: "" },
      { id: "c-ops", name: "Ops runbooks", parentId: "" },
    ].map((c) => ({ ...c, createdAt: now(), updatedAt: now() }));
    const prompts = [
      { id: "p-sys-coder", name: "Senior engineer persona", kind: "system", categoryId: "c-coding", systemPromptId: "", tags: ["persona", "coding"], variables: ["language"], body: "You are a senior {{language}} engineer.\n\n- Prefer small, focused diffs\n- Explain trade-offs briefly\n- Never invent APIs" },
      { id: "p-sys-researcher", name: "Careful researcher persona", kind: "system", categoryId: "c-research", systemPromptId: "", tags: ["persona", "research"], variables: [], body: "You are a careful researcher. Cite sources. Say \"I don't know\" when unsure." },
      { id: "p-refactor", name: "Refactor module", kind: "user", categoryId: "c-coding", systemPromptId: "p-sys-coder", tags: ["coding", "refactor"], variables: ["module", "goal"], body: "Refactor `{{module}}` with this goal:\n\n> {{goal}}\n\nConstraints:\n1. Keep the public API stable\n2. Add tests for changed behavior" },
      { id: "p-review", name: "Code review checklist", kind: "user", categoryId: "c-coding", systemPromptId: "p-sys-coder", tags: ["coding", "review"], variables: ["diff"], body: "Review this diff:\n\n```\n{{diff}}\n```\n\nCheck: correctness, naming, error handling, tests." },
      { id: "p-litrev", name: "Literature summary", kind: "user", categoryId: "c-research", systemPromptId: "p-sys-researcher", tags: ["research"], variables: ["topic", "count"], body: "Summarize the top {{count}} papers on **{{topic}}**. For each: key claim, method, limitation." },
      { id: "p-blogpost", name: "Blog post draft", kind: "user", categoryId: "c-writing", systemPromptId: "", tags: ["writing", "draft"], variables: ["subject", "audience"], body: "# Draft: {{subject}}\n\nWrite a blog post for {{audience}}.\n\n- Hook in the first two sentences\n- One concrete example per section" },
      { id: "p-incident", name: "Incident triage", kind: "user", categoryId: "", systemPromptId: "", tags: ["ops"], variables: ["alert"], body: "Triage alert: {{alert}}\n\n1. Impact?\n2. Recent deploys?\n3. Mitigation options" },
    ].map((p) => ({ version: 1, createdAt: now(), updatedAt: now(), ...p }));
    const notes = [
      { id: "n-refactor-tip", title: "Works best with model X", categoryId: "c-coding", promptId: "p-refactor", tags: ["model-notes"], body: "Use **model X** with temperature 0.2.\n\nModel Y tends to rewrite too much." },
      { id: "n-review-tip", title: "Chunk large diffs", categoryId: "c-coding", promptId: "p-review", tags: ["usage"], body: "For diffs > 400 lines, split by file and run the prompt per chunk." },
      { id: "n-litrev-tip", title: "Ask for BibTeX", categoryId: "c-research", promptId: "p-litrev", tags: ["usage"], body: "Appending `Output BibTeX entries.` gives clean citations." },
      { id: "n-glossary", title: "Prompting glossary", categoryId: "c-writing", promptId: "", tags: ["reference"], body: "- *few-shot*: examples in the prompt\n- *CoT*: chain of thought\n- *system prompt*: persistent instructions" },
      { id: "n-scratch", title: "Scratchpad", categoryId: "", promptId: "", tags: [], body: "Loose ideas live here." },
    ].map((n) => ({ createdAt: now(), updatedAt: now(), ...n }));
    const db = { categories: cats, prompts, notes };

    const notFound = () => ({ status: 404, body: { error: { code: "not_found", message: "resource not found" } } });
    const bad = (message, field) => ({ status: 422, body: { error: { code: "validation_failed", message, field } } });
    const ok = (body, status = 200) => ({ status, body });

    function handle(method, path, params, payload) {
      const seg = path.replace(/^\/v1\//, "").split("/").filter(Boolean);
      const col = seg[0];
      if (col === "tags") {
        const tags = new Set();
        db.prompts.forEach((p) => p.tags.forEach((t) => tags.add(t)));
        db.notes.forEach((n) => n.tags.forEach((t) => tags.add(t)));
        return ok({ items: [...tags].sort(), total: tags.size });
      }
      if (col === "categories") return handleCategories(method, seg, params, payload);
      if (col === "prompts") return handlePrompts(method, seg, params, payload);
      if (col === "notes") return handleNotes(method, seg, params, payload);
      return notFound();
    }

    function handleCategories(method, seg, params, payload) {
      if (seg.length === 1) {
        if (method === "GET") return ok({ items: [...db.categories], total: db.categories.length });
        if (method === "POST") {
          const name = (payload.name || "").trim();
          if (!name) return bad("name is required", "name");
          const c = { id: id(), name, parentId: payload.parentId || "", createdAt: now(), updatedAt: now() };
          db.categories.push(c);
          return ok(c, 201);
        }
      }
      const cat = db.categories.find((c) => c.id === seg[1]);
      if (!cat) return notFound();
      if (method === "GET") return ok(cat);
      if (method === "PUT") {
        const name = (payload.name || "").trim();
        if (!name) return bad("name is required", "name");
        const pid = payload.parentId || "";
        for (let cur = pid; cur; ) {
          if (cur === cat.id) return bad("category cannot be its own ancestor", "parentId");
          const parent = db.categories.find((c) => c.id === cur);
          cur = parent ? parent.parentId : "";
        }
        Object.assign(cat, { name, parentId: pid, updatedAt: now() });
        return ok(cat);
      }
      if (method === "DELETE") {
        const hasChildren = db.categories.some((c) => c.parentId === cat.id);
        const hasItems = db.prompts.some((p) => p.categoryId === cat.id) || db.notes.some((n) => n.categoryId === cat.id);
        if ((hasChildren || hasItems) && params.get("force") !== "true") {
          return bad("category is not empty; pass force=true to re-parent children and unassign items");
        }
        db.categories.forEach((c) => { if (c.parentId === cat.id) c.parentId = cat.parentId; });
        db.prompts.forEach((p) => { if (p.categoryId === cat.id) p.categoryId = ""; });
        db.notes.forEach((n) => { if (n.categoryId === cat.id) n.categoryId = ""; });
        db.categories = db.categories.filter((c) => c.id !== cat.id);
        return { status: 204, body: null };
      }
      return notFound();
    }

    function validatePrompt(payload, existingId) {
      const name = (payload.name || "").trim();
      if (!name) return bad("name is required", "name");
      if (!(payload.body || "").trim()) return bad("body is required", "body");
      const kind = payload.kind || "user";
      if (kind !== "system" && kind !== "user") return bad("kind must be system or user", "kind");
      const spid = payload.systemPromptId || "";
      if (kind === "system" && spid) return bad("systemPromptId must be empty for system prompts", "systemPromptId");
      if (spid) {
        const ref = db.prompts.find((p) => p.id === spid);
        if (!ref || ref.kind !== "system") return bad("systemPromptId must reference a system prompt", "systemPromptId");
        if (existingId && spid === existingId) return bad("prompt cannot reference itself", "systemPromptId");
      }
      if (payload.categoryId && !db.categories.find((c) => c.id === payload.categoryId)) {
        return bad("unknown category", "categoryId");
      }
      return null;
    }

    const normTags = (tags) => [...new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();

    function handlePrompts(method, seg, params, payload) {
      if (seg.length === 1) {
        if (method === "GET") {
          let items = [...db.prompts];
          if (params.get("category")) items = items.filter((p) => p.categoryId === params.get("category"));
          if (params.get("kind")) items = items.filter((p) => (p.kind || "user") === params.get("kind"));
          params.getAll("tag").forEach((t) => { items = items.filter((p) => p.tags.includes(t)); });
          const q = (params.get("q") || "").toLowerCase();
          if (q) items = items.filter((p) => p.name.toLowerCase().includes(q) || p.body.toLowerCase().includes(q));
          return ok({ items, total: items.length });
        }
        if (method === "POST") {
          const err = validatePrompt(payload, null);
          if (err) return err;
          const p = {
            id: id(), name: payload.name.trim(), kind: payload.kind || "user",
            categoryId: payload.categoryId || "", systemPromptId: payload.systemPromptId || "",
            tags: normTags(payload.tags), body: payload.body, variables: payload.variables || [],
            version: 1, createdAt: now(), updatedAt: now(),
          };
          db.prompts.push(p);
          return ok(p, 201);
        }
      }
      const prompt = db.prompts.find((p) => p.id === seg[1]);
      if (!prompt) return notFound();
      if (seg[2] === "notes") {
        const items = db.notes.filter((n) => n.promptId === prompt.id);
        return ok({ items, total: items.length });
      }
      if (method === "GET") return ok(prompt);
      if (method === "PUT") {
        const err = validatePrompt(payload, prompt.id);
        if (err) return err;
        Object.assign(prompt, {
          name: payload.name.trim(), kind: payload.kind || "user",
          categoryId: payload.categoryId || "", systemPromptId: payload.systemPromptId || "",
          tags: normTags(payload.tags), body: payload.body, variables: payload.variables || [],
          version: prompt.version + 1, updatedAt: now(),
        });
        if (prompt.kind === "system") {
          // ensure no dangling self-reference semantics
          prompt.systemPromptId = "";
        }
        return ok(prompt);
      }
      if (method === "DELETE") {
        const refs = db.prompts.filter((p) => p.systemPromptId === prompt.id);
        if (refs.length > 0 && params.get("force") !== "true") {
          return bad(`system prompt is referenced by ${refs.length} user prompt(s); pass force=true to clear references`);
        }
        refs.forEach((p) => { p.systemPromptId = ""; });
        db.notes.forEach((n) => { if (n.promptId === prompt.id) n.promptId = ""; });
        db.prompts = db.prompts.filter((p) => p.id !== prompt.id);
        return { status: 204, body: null };
      }
      return notFound();
    }

    function handleNotes(method, seg, params, payload) {
      if (seg.length === 1) {
        if (method === "GET") {
          let items = [...db.notes];
          if (params.get("category")) items = items.filter((n) => n.categoryId === params.get("category"));
          if (params.get("prompt")) items = items.filter((n) => n.promptId === params.get("prompt"));
          params.getAll("tag").forEach((t) => { items = items.filter((n) => n.tags.includes(t)); });
          const q = (params.get("q") || "").toLowerCase();
          if (q) items = items.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
          return ok({ items, total: items.length });
        }
        if (method === "POST") {
          const title = (payload.title || "").trim();
          if (!title) return bad("title is required", "title");
          if (payload.promptId && !db.prompts.find((p) => p.id === payload.promptId)) return bad("unknown prompt", "promptId");
          const n = {
            id: id(), title, categoryId: payload.categoryId || "", promptId: payload.promptId || "",
            tags: normTags(payload.tags), body: payload.body || "", createdAt: now(), updatedAt: now(),
          };
          db.notes.push(n);
          return ok(n, 201);
        }
      }
      const note = db.notes.find((n) => n.id === seg[1]);
      if (!note) return notFound();
      if (method === "GET") return ok(note);
      if (method === "PUT") {
        const title = (payload.title || "").trim();
        if (!title) return bad("title is required", "title");
        if (payload.promptId && !db.prompts.find((p) => p.id === payload.promptId)) return bad("unknown prompt", "promptId");
        Object.assign(note, {
          title, categoryId: payload.categoryId || "", promptId: payload.promptId || "",
          tags: normTags(payload.tags), body: payload.body || "", updatedAt: now(),
        });
        return ok(note);
      }
      if (method === "DELETE") {
        db.notes = db.notes.filter((n) => n.id !== note.id);
        return { status: 204, body: null };
      }
      return notFound();
    }

    return { handle };
  })();

  // ------------------------------------------------------------------
  // API layer
  // ------------------------------------------------------------------
  async function request(method, path, body) {
    const url = new URL(path, location.origin);
    if (useMock) {
      const res = mock.handle(method, url.pathname.replace(/^\/api/, ""), url.searchParams, body || {});
      await new Promise((r) => setTimeout(r, 30));
      if (res.status >= 400) {
        const err = new Error(res.body.error.message);
        err.envelope = res.body.error;
        err.status = res.status;
        throw err;
      }
      return res.body === null ? null : JSON.parse(JSON.stringify(res.body));
    }
    const response = await fetch(url.pathname + url.search, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const env = payload && payload.error ? payload.error : { code: `http_${response.status}`, message: "request failed" };
      const err = new Error(env.message);
      err.envelope = env;
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  const api = {
    listPrompts: () => request("GET", "/api/prompts?limit=1000"),
    listNotes: () => request("GET", "/api/notes?limit=1000"),
    listCategories: () => request("GET", "/api/categories"),
    listTags: () => request("GET", "/api/tags"),
    createPrompt: (p) => request("POST", "/api/prompts", p),
    updatePrompt: (id, p) => request("PUT", `/api/prompts/${id}`, p),
    deletePrompt: (id, force) => request("DELETE", `/api/prompts/${id}${force ? "?force=true" : ""}`),
    createNote: (n) => request("POST", "/api/notes", n),
    updateNote: (id, n) => request("PUT", `/api/notes/${id}`, n),
    deleteNote: (id) => request("DELETE", `/api/notes/${id}`),
    createCategory: (c) => request("POST", "/api/categories", c),
    updateCategory: (id, c) => request("PUT", `/api/categories/${id}`, c),
    deleteCategory: (id, force) => request("DELETE", `/api/categories/${id}${force ? "?force=true" : ""}`),
  };

  const v2 = () => state.apiMode === "v2" || state.apiMode === "mock";

  async function loadAll() {
    state.loading = true;
    renderTree();
    try {
      if (useMock) {
        state.apiMode = "mock";
      } else if (state.apiMode === "detecting") {
        try {
          await api.listCategories();
          state.apiMode = "v2";
        } catch (e) {
          state.apiMode = e.status === 404 || e.status === 405 ? "v1" : "v2";
          if (e.status !== 404 && e.status !== 405) throw e;
        }
      }
      const [prompts, notes, tags, categories] = await Promise.all([
        api.listPrompts(),
        api.listNotes(),
        api.listTags().catch(() => ({ items: [] })),
        v2() ? api.listCategories() : Promise.resolve({ items: [] }),
      ]);
      state.prompts = prompts.items || [];
      state.notes = notes.items || [];
      state.tags = (tags.items || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
      state.categories = categories.items || [];
      state.loading = false;
      setStatusBar();
      renderAll();
    } catch (e) {
      state.loading = false;
      state.apiMode = useMock ? "mock" : "offline";
      setStatusBar();
      renderAll();
      toastError(e);
    }
  }

  // ------------------------------------------------------------------
  // Toasts + status bar
  // ------------------------------------------------------------------
  function toast(message, cls = "", code = "") {
    const div = document.createElement("div");
    div.className = `toast ${cls}`;
    if (code) {
      const c = document.createElement("div");
      c.className = "toast-code";
      c.textContent = code;
      div.append(c);
    }
    const m = document.createElement("div");
    m.textContent = message;
    div.append(m);
    $("toasts").append(div);
    setTimeout(() => div.remove(), 4200);
  }
  const toastOk = (msg) => toast(msg, "ok");
  function toastError(e) {
    const env = e && e.envelope;
    if (env) {
      toast(env.message + (env.field ? ` (field: ${env.field})` : ""), "error", env.code);
    } else {
      toast(e && e.message ? e.message : "request failed", "error");
    }
  }

  function setStatusBar() {
    const modeLabel = { v2: "v2", v1: "v1 (compat)", mock: "mock", offline: "offline", detecting: "…" }[state.apiMode];
    $("sb-api").textContent = `API: ${modeLabel}`;
    const sys = state.prompts.filter((p) => (p.kind || "user") === "system").length;
    $("sb-counts").textContent =
      `${state.prompts.length} prompts (${sys} system) · ${state.notes.length} notes` +
      (v2() ? ` · ${state.categories.length} categories` : "");
  }
  function sbMsg(text) {
    $("sb-msg").textContent = text;
    if (text) setTimeout(() => { if ($("sb-msg").textContent === text) $("sb-msg").textContent = ""; }, 3000);
  }

  // ------------------------------------------------------------------
  // Tree
  // ------------------------------------------------------------------
  const promptKind = (p) => p.kind || "user";
  const itemTitle = (item, type) => (type === "prompt" ? item.name : item.title);

  function matchesFilters(item, type) {
    if (state.kindFilter === "notes" && type !== "note") return false;
    if ((state.kindFilter === "system" || state.kindFilter === "user") &&
        (type !== "prompt" || promptKind(item) !== state.kindFilter)) return false;
    if (state.tagFilter && !(item.tags || []).includes(state.tagFilter)) return false;
    const q = state.search.trim().toLowerCase();
    if (q) {
      const hay = `${itemTitle(item, type)}\n${item.body || ""}\n${(item.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function buildCategoryTree() {
    const byParent = new Map();
    state.categories.forEach((c) => {
      const key = c.parentId || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    });
    byParent.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));
    const build = (parentId) =>
      (byParent.get(parentId) || []).map((c) => ({
        category: c,
        children: build(c.id),
        prompts: state.prompts.filter((p) => p.categoryId === c.id && matchesFilters(p, "prompt")),
        notes: state.notes.filter((n) => n.categoryId === c.id && matchesFilters(n, "note")),
      }));
    return build("");
  }

  const nodeCount = (node) =>
    node.prompts.length + node.notes.length + node.children.reduce((sum, ch) => sum + nodeCount(ch), 0);

  function renderTree() {
    const tree = $("tree");
    tree.textContent = "";
    if (state.loading) {
      const d = document.createElement("div");
      d.className = "tree-loading";
      d.innerHTML = `<span class="spinner"></span> loading…`;
      tree.append(d);
      return;
    }
    if (v2()) renderCategoryTree(tree);
    else renderTagTree(tree);
  }

  function makeRow({ depth, chevron, badge, label, count, selected, onClick, actions }) {
    const row = document.createElement("div");
    row.className = "tree-row" + (selected ? " selected" : "");
    row.style.paddingLeft = `${6 + depth * 14}px`;
    const chev = document.createElement("span");
    chev.className = "tree-chevron" + (chevron === null ? " leaf" : chevron ? " open" : "");
    chev.textContent = "▶";
    row.append(chev);
    if (badge) {
      const b = document.createElement("span");
      b.className = `badge ${badge.cls}`;
      b.textContent = badge.text;
      row.append(b);
    }
    const lab = document.createElement("span");
    lab.className = "tree-label";
    lab.textContent = label;
    row.append(lab);
    if (count !== undefined) {
      const c = document.createElement("span");
      c.className = "tree-count";
      c.textContent = count;
      row.append(c);
    }
    if (actions && actions.length) {
      const wrap = document.createElement("span");
      wrap.className = "row-actions";
      actions.forEach(([txt, title, fn]) => {
        const b = document.createElement("button");
        b.className = "icon-btn";
        b.textContent = txt;
        b.title = title;
        b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
        wrap.append(b);
      });
      row.append(wrap);
    }
    row.addEventListener("click", onClick);
    return row;
  }

  function itemRow(item, type, depth) {
    const kind = type === "prompt" ? promptKind(item) : "note";
    const badge = kind === "system" ? { cls: "sys", text: "S" } : kind === "user" ? { cls: "usr", text: "U" } : { cls: "note", text: "N" };
    const active = state.activeTab && state.activeTab.type === type && state.activeTab.id === item.id;
    return makeRow({
      depth,
      chevron: null,
      badge,
      label: itemTitle(item, type),
      selected: !!active,
      onClick: () => openItem(type, item.id),
    });
  }

  function renderCategoryTree(tree) {
    const roots = buildCategoryTree();
    const uncatPrompts = state.prompts.filter((p) => !p.categoryId && matchesFilters(p, "prompt"));
    const uncatNotes = state.notes.filter((n) => !n.categoryId && matchesFilters(n, "note"));
    const total = roots.reduce((s, r) => s + nodeCount(r), 0) + uncatPrompts.length + uncatNotes.length;
    if (total === 0 && state.categories.length === 0) {
      const d = document.createElement("div");
      d.className = "tree-empty";
      d.textContent = state.search || state.tagFilter || state.kindFilter
        ? "Nothing matches the current filters."
        : "No prompts or notes yet. Create one with the buttons above.";
      tree.append(d);
      return;
    }

    const renderNode = (node, depth) => {
      const catKey = `cat:${node.category.id}`;
      const open = !state.collapsed.has(catKey);
      tree.append(makeRow({
        depth,
        chevron: open,
        badge: { cls: "cat", text: "🗀" },
        label: node.category.name,
        count: nodeCount(node),
        onClick: () => { toggleCollapsed(catKey); },
        actions: [
          ["✎", "Rename / move category", () => categoryModal(node.category)],
          ["＋", "New subcategory", () => categoryModal(null, node.category.id)],
          ["🗑", "Delete category", () => deleteCategoryFlow(node.category)],
        ],
      }));
      if (!open) return;
      node.children.forEach((ch) => renderNode(ch, depth + 1));
      node.prompts.forEach((p) => tree.append(itemRow(p, "prompt", depth + 1)));
      node.notes.forEach((n) => tree.append(itemRow(n, "note", depth + 1)));
    };
    roots.forEach((r) => renderNode(r, 0));

    if (uncatPrompts.length || uncatNotes.length) {
      const key = "cat:__uncat__";
      const open = !state.collapsed.has(key);
      tree.append(makeRow({
        depth: 0,
        chevron: open,
        badge: { cls: "cat", text: "🗀" },
        label: "Uncategorized",
        count: uncatPrompts.length + uncatNotes.length,
        onClick: () => toggleCollapsed(key),
      }));
      if (open) {
        uncatPrompts.forEach((p) => tree.append(itemRow(p, "prompt", 1)));
        uncatNotes.forEach((n) => tree.append(itemRow(n, "note", 1)));
      }
    }
  }

  function renderTagTree(tree) {
    // v1 fallback: group items into a flat tree by tag.
    const groups = new Map();
    const add = (tag, item, type) => {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push([item, type]);
    };
    state.prompts.filter((p) => matchesFilters(p, "prompt")).forEach((p) => {
      if (!p.tags || p.tags.length === 0) add("(untagged)", p, "prompt");
      else p.tags.forEach((t) => add(t, p, "prompt"));
    });
    state.notes.filter((n) => matchesFilters(n, "note")).forEach((n) => {
      if (!n.tags || n.tags.length === 0) add("(untagged)", n, "note");
      else n.tags.forEach((t) => add(t, n, "note"));
    });
    if (groups.size === 0) {
      const d = document.createElement("div");
      d.className = "tree-empty";
      d.textContent = "No prompts or notes match.";
      tree.append(d);
      return;
    }
    [...groups.keys()].sort().forEach((tag) => {
      const key = `tag:${tag}`;
      const open = !state.collapsed.has(key);
      const items = groups.get(tag);
      tree.append(makeRow({
        depth: 0,
        chevron: open,
        badge: { cls: "cat", text: "#" },
        label: tag,
        count: items.length,
        onClick: () => toggleCollapsed(key),
      }));
      if (open) items.forEach(([item, type]) => tree.append(itemRow(item, type, 1)));
    });
  }

  function toggleCollapsed(key) {
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    saveCollapsed();
    renderTree();
  }

  function renderTagStrip() {
    const strip = $("tag-strip");
    strip.textContent = "";
    const tags = state.tags.length
      ? state.tags
      : [...new Set([...state.prompts, ...state.notes].flatMap((i) => i.tags || []))].sort();
    tags.forEach((tag) => {
      const b = document.createElement("button");
      b.className = "tag-chip" + (state.tagFilter === tag ? " active" : "");
      b.textContent = `#${tag}`;
      b.addEventListener("click", () => {
        state.tagFilter = state.tagFilter === tag ? null : tag;
        renderTagStrip();
        renderTree();
      });
      strip.append(b);
    });
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------
  let tabSeq = 0;

  function findItem(type, id) {
    return (type === "prompt" ? state.prompts : state.notes).find((i) => i.id === id) || null;
  }

  function draftFor(type, item) {
    if (type === "prompt") {
      return item
        ? { name: item.name, kind: promptKind(item), categoryId: item.categoryId || "", systemPromptId: item.systemPromptId || "", tags: (item.tags || []).join(", "), variables: (item.variables || []).join(", "), body: item.body || "" }
        : { name: "", kind: "user", categoryId: "", systemPromptId: "", tags: "", variables: "", body: "" };
    }
    return item
      ? { title: item.title, categoryId: item.categoryId || "", promptId: item.promptId || "", tags: (item.tags || []).join(", "), body: item.body || "" }
      : { title: "", categoryId: "", promptId: "", tags: "", body: "" };
  }

  function openItem(type, id, opts = {}) {
    const existing = state.tabs.find((t) => t.type === type && t.id === id);
    if (existing && id !== null) {
      state.activeTab = existing;
    } else {
      const item = id === null ? null : findItem(type, id);
      const tab = {
        key: `tab${tabSeq++}`,
        type,
        id,
        draft: draftFor(type, item),
        dirty: id === null,
        viewMode: "split",
      };
      if (opts.presets) Object.assign(tab.draft, opts.presets);
      state.tabs.push(tab);
      state.activeTab = tab;
    }
    renderAll();
    if (id === null) {
      const el = document.querySelector(".detail-title-input");
      if (el) el.focus();
    }
  }

  function closeTab(tab) {
    if (tab.dirty && !confirm("Discard unsaved changes in this tab?")) return;
    const idx = state.tabs.indexOf(tab);
    state.tabs.splice(idx, 1);
    if (state.activeTab === tab) state.activeTab = state.tabs[Math.min(idx, state.tabs.length - 1)] || null;
    renderAll();
  }

  function renderTabs() {
    const bar = $("tab-bar");
    bar.textContent = "";
    state.tabs.forEach((tab) => {
      const item = tab.id === null ? null : findItem(tab.type, tab.id);
      const label = tab.id === null
        ? (tab.type === "prompt" ? "new prompt" : "new note")
        : item ? itemTitle(item, tab.type) : "(deleted)";
      const btn = document.createElement("button");
      btn.className = "tab" + (tab === state.activeTab ? " active" : "");
      btn.setAttribute("role", "tab");
      const badge = document.createElement("span");
      const kind = tab.type === "prompt" ? (tab.draft.kind || "user") : "note";
      badge.className = "badge " + (kind === "system" ? "sys" : kind === "user" ? "usr" : "note");
      badge.textContent = kind === "system" ? "S" : kind === "user" ? "U" : "N";
      btn.append(badge);
      const lab = document.createElement("span");
      lab.className = "tab-label";
      lab.textContent = label;
      btn.append(lab);
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "dirty-dot";
        dot.textContent = "●";
        btn.append(dot);
      }
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "✕";
      close.setAttribute("role", "button");
      close.addEventListener("click", (ev) => { ev.stopPropagation(); closeTab(tab); });
      btn.append(close);
      btn.addEventListener("click", () => { state.activeTab = tab; renderAll(); });
      btn.addEventListener("auxclick", (ev) => { if (ev.button === 1) closeTab(tab); });
      bar.append(btn);
    });
  }

  // ------------------------------------------------------------------
  // Markdown mini-renderer (safe: escapes all HTML first)
  // ------------------------------------------------------------------
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const highlightVars = (escaped) =>
    escaped.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m) => `<span class="var">${m}</span>`);

  function inlineMd(escaped) {
    return highlightVars(escaped)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown(src) {
    const lines = src.split("\n");
    const out = [];
    let inCode = false, codeBuf = [], listType = null, para = [];
    const flushPara = () => {
      if (para.length) { out.push(`<p>${inlineMd(escapeHtml(para.join(" ")))}</p>`); para = []; }
    };
    const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    for (const raw of lines) {
      if (raw.trim().startsWith("```")) {
        flushPara(); flushList();
        if (inCode) { out.push(`<pre><code>${highlightVars(escapeHtml(codeBuf.join("\n")))}</code></pre>`); codeBuf = []; }
        inCode = !inCode;
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }
      const line = raw;
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inlineMd(escapeHtml(h[2]))}</h${h[1].length}>`); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const want = ul ? "ul" : "ol";
        if (listType !== want) { flushList(); out.push(`<${want}>`); listType = want; }
        out.push(`<li>${inlineMd(escapeHtml((ul || ol)[1]))}</li>`);
        continue;
      }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) { flushPara(); flushList(); out.push(`<blockquote>${inlineMd(escapeHtml(bq[1]))}</blockquote>`); continue; }
      if (line.trim() === "") { flushPara(); flushList(); continue; }
      para.push(line.trim());
    }
    if (inCode && codeBuf.length) out.push(`<pre><code>${highlightVars(escapeHtml(codeBuf.join("\n")))}</code></pre>`);
    flushPara(); flushList();
    return out.join("\n");
  }

  // ------------------------------------------------------------------
  // Detail views
  // ------------------------------------------------------------------
  function field(labelText, control) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrap.append(label, control);
    return wrap;
  }

  function select(options, value, onChange) {
    const sel = document.createElement("select");
    options.forEach(([val, text]) => {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = text;
      sel.append(o);
    });
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  function textInput(value, placeholder, onInput, mono = false) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    if (mono) input.classList.add("mono");
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function categoryOptions() {
    const opts = [["", "(uncategorized)"]];
    const walk = (parentId, prefix) => {
      state.categories
        .filter((c) => (c.parentId || "") === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((c) => {
          opts.push([c.id, prefix + c.name]);
          walk(c.id, prefix + c.name + " / ");
        });
    };
    walk("", "");
    return opts;
  }

  const csv = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

  function markDirty(tab) {
    if (!tab.dirty) { tab.dirty = true; renderTabs(); }
  }

  function renderEditorArea() {
    const area = $("editor-area");
    area.textContent = "";
    const tab = state.activeTab;
    if (!tab) {
      area.append(buildWelcome());
      return;
    }
    if (tab.type === "prompt") area.append(buildPromptDetail(tab));
    else area.append(buildNoteDetail(tab));
  }

  function buildWelcome() {
    const div = document.createElement("div");
    div.className = "welcome";
    div.innerHTML = `
      <div class="welcome-inner">
        <h1>cue-note</h1>
        <p class="muted">local-first prompt &amp; notes manager</p>
        <ul class="welcome-keys">
          <li><kbd>/</kbd> search</li>
          <li><kbd>Ctrl</kbd>+<kbd>K</kbd> command palette</li>
          <li><kbd>Ctrl</kbd>+<kbd>S</kbd> save active tab</li>
        </ul>
        <div class="welcome-actions">
          <button class="btn" id="welcome-new-prompt">New prompt</button>
          <button class="btn secondary" id="welcome-new-note">New note</button>
        </div>
      </div>`;
    div.querySelector("#welcome-new-prompt").addEventListener("click", () => openItem("prompt", null));
    div.querySelector("#welcome-new-note").addEventListener("click", () => openItem("note", null));
    return div;
  }

  function buildEditorSplit(tab, opts = {}) {
    const wrap = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.className = "editor-toolbar";
    const seg = document.createElement("div");
    seg.className = "seg";
    [["source", "source"], ["split", "split"], ["preview", "preview"]].forEach(([mode, text]) => {
      const b = document.createElement("button");
      b.textContent = text;
      if (tab.viewMode === mode) b.classList.add("active");
      b.addEventListener("click", () => { tab.viewMode = mode; renderEditorArea(); });
      seg.append(b);
    });
    toolbar.append(seg);
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.style.fontSize = "11px";
    hint.textContent = opts.hint || "markdown · {{variables}} are highlighted";
    toolbar.append(hint);
    wrap.append(toolbar);

    const split = document.createElement("div");
    split.className = "split" + (tab.viewMode === "source" ? " source-only" : tab.viewMode === "preview" ? " preview-only" : "");

    const paneSource = document.createElement("div");
    paneSource.className = "pane-source";
    const hl = document.createElement("pre");
    hl.className = "hl-layer";
    const ta = document.createElement("textarea");
    ta.className = "body-input";
    ta.value = tab.draft.body;
    ta.spellcheck = false;
    ta.placeholder = "Write markdown here…";
    const paint = () => {
      // Trailing newline keeps the layer height in sync with the textarea.
      hl.innerHTML = highlightVars(escapeHtml(ta.value)) + "\n";
    };
    paint();
    const preview = document.createElement("div");
    preview.className = "pane-preview md";
    const paintPreview = () => {
      preview.innerHTML = tab.draft.body.trim()
        ? renderMarkdown(tab.draft.body)
        : '<div class="preview-empty">Nothing to preview yet.</div>';
    };
    paintPreview();
    ta.addEventListener("input", () => {
      tab.draft.body = ta.value;
      markDirty(tab);
      paint();
      paintPreview();
    });
    ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; });
    paneSource.append(hl, ta);
    split.append(paneSource, preview);
    wrap.append(split);
    return wrap;
  }

  function metaLine(item) {
    if (!item) return null;
    const div = document.createElement("div");
    div.className = "detail-meta-line";
    const upd = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "";
    div.textContent = `id ${item.id}` + (item.version ? ` · v${item.version}` : "") + (upd ? ` · updated ${upd}` : "");
    return div;
  }

  function buildPromptDetail(tab) {
    const item = tab.id ? findItem("prompt", tab.id) : null;
    const d = tab.draft;
    const root = document.createElement("div");
    root.className = "detail";

    const head = document.createElement("div");
    head.className = "detail-head";
    const kindBadge = document.createElement("span");
    kindBadge.className = "badge " + (d.kind === "system" ? "sys" : "usr");
    kindBadge.textContent = d.kind === "system" ? "SYSTEM" : "USER";
    head.append(kindBadge);
    const title = document.createElement("input");
    title.className = "detail-title-input";
    title.value = d.name;
    title.placeholder = "Prompt name";
    title.addEventListener("input", () => { d.name = title.value; markDirty(tab); });
    head.append(title);
    root.append(head);
    const ml = metaLine(item);
    if (ml) root.append(ml);

    const grid = document.createElement("div");
    grid.className = "field-grid";
    grid.append(field("kind", select([["user", "user"], ["system", "system"]], d.kind, (v) => {
      d.kind = v;
      if (v === "system") d.systemPromptId = "";
      markDirty(tab);
      renderEditorArea();
      renderTabs();
    })));
    if (v2()) {
      grid.append(field("category", select(categoryOptions(), d.categoryId, (v) => { d.categoryId = v; markDirty(tab); })));
    }
    if (d.kind === "user" && v2()) {
      const sysOptions = [["", "(none)"]].concat(
        state.prompts
          .filter((p) => promptKind(p) === "system" && p.id !== tab.id)
          .map((p) => [p.id, p.name])
      );
      grid.append(field("system prompt", select(sysOptions, d.systemPromptId, (v) => {
        d.systemPromptId = v;
        markDirty(tab);
        renderEditorArea();
      })));
    }
    grid.append(field("tags (comma-separated)", textInput(d.tags, "coding, review", (v) => { d.tags = v; markDirty(tab); }, true)));
    grid.append(field("variables (ordered)", textInput(d.variables, "module, goal", (v) => { d.variables = v; markDirty(tab); }, true)));
    root.append(grid);

    if (d.kind === "user" && d.systemPromptId) {
      const sys = findItem("prompt", d.systemPromptId);
      if (sys) {
        const box = document.createElement("div");
        box.className = "sys-preview";
        const headRow = document.createElement("div");
        headRow.className = "sys-preview-head";
        const b = document.createElement("span");
        b.className = "badge sys";
        b.textContent = "S";
        const link = document.createElement("a");
        link.textContent = sys.name;
        link.title = "Open system prompt";
        link.addEventListener("click", () => openItem("prompt", sys.id));
        const lbl = document.createElement("span");
        lbl.className = "muted";
        lbl.textContent = "associated system prompt";
        headRow.append(b, link, lbl);
        const pre = document.createElement("pre");
        pre.textContent = sys.body;
        box.append(headRow, pre);
        root.append(box);
      }
    }

    root.append(buildEditorSplit(tab));

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const save = document.createElement("button");
    save.className = "btn";
    save.textContent = tab.id ? "Save (Ctrl+S)" : "Create prompt";
    save.addEventListener("click", () => savePromptTab(tab));
    actions.append(save);
    if (tab.id) {
      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => deletePromptFlow(item));
      actions.append(del);
      const copy = document.createElement("button");
      copy.className = "btn secondary";
      copy.textContent = "Copy body";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(d.body); toastOk("Prompt body copied"); }
        catch { toast("Clipboard unavailable", "error"); }
      });
      actions.append(copy);
    }
    root.append(actions);

    if (tab.id && item) root.append(buildAttachedNotes(item));
    return root;
  }

  function buildAttachedNotes(prompt) {
    const wrap = document.createElement("div");
    wrap.className = "attached-notes";
    const h = document.createElement("h3");
    h.textContent = "Attached notes";
    const add = document.createElement("button");
    add.className = "btn small secondary";
    add.textContent = "+ attach note";
    add.addEventListener("click", () =>
      openItem("note", null, { presets: { promptId: prompt.id, categoryId: prompt.categoryId || "" } }));
    h.append(add);
    wrap.append(h);
    const attached = state.notes.filter((n) => n.promptId === prompt.id);
    if (attached.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = v2()
        ? "No notes attached. Attach usage tips, model observations, or gotchas."
        : "Attached notes need the v2 API (or ?mock=1).";
      wrap.append(p);
      return wrap;
    }
    attached.forEach((note) => {
      const card = document.createElement("div");
      card.className = "note-card";
      const head = document.createElement("div");
      head.className = "note-card-head";
      const b = document.createElement("span");
      b.className = "badge note";
      b.textContent = "N";
      const t = document.createElement("span");
      t.className = "note-card-title";
      t.textContent = note.title;
      t.title = "Open note";
      t.addEventListener("click", () => openItem("note", note.id));
      const edit = document.createElement("button");
      edit.className = "link-btn";
      edit.textContent = "edit";
      edit.addEventListener("click", () => openItem("note", note.id));
      const detach = document.createElement("button");
      detach.className = "link-btn danger";
      detach.textContent = "detach";
      detach.addEventListener("click", async () => {
        try {
          await api.updateNote(note.id, { ...note, promptId: "" });
          toastOk("Note detached");
          await refreshData();
        } catch (e) { toastError(e); }
      });
      head.append(b, t, edit, detach);
      card.append(head);
      if (note.body && note.body.trim()) {
        const body = document.createElement("div");
        body.className = "note-card-body";
        body.textContent = note.body;
        card.append(body);
      }
      wrap.append(card);
    });
    return wrap;
  }

  function buildNoteDetail(tab) {
    const item = tab.id ? findItem("note", tab.id) : null;
    const d = tab.draft;
    const root = document.createElement("div");
    root.className = "detail";

    const head = document.createElement("div");
    head.className = "detail-head";
    const badge = document.createElement("span");
    badge.className = "badge note";
    badge.textContent = "NOTE";
    head.append(badge);
    const title = document.createElement("input");
    title.className = "detail-title-input";
    title.value = d.title;
    title.placeholder = "Note title";
    title.addEventListener("input", () => { d.title = title.value; markDirty(tab); });
    head.append(title);
    root.append(head);
    const ml = metaLine(item);
    if (ml) root.append(ml);

    const grid = document.createElement("div");
    grid.className = "field-grid";
    if (v2()) {
      grid.append(field("category", select(categoryOptions(), d.categoryId, (v) => { d.categoryId = v; markDirty(tab); })));
      const promptOptions = [["", "(standalone note)"]].concat(
        state.prompts.map((p) => [p.id, `${promptKind(p) === "system" ? "[S] " : ""}${p.name}`])
      );
      grid.append(field("attached to prompt", select(promptOptions, d.promptId, (v) => { d.promptId = v; markDirty(tab); })));
    }
    grid.append(field("tags (comma-separated)", textInput(d.tags, "usage, model-notes", (v) => { d.tags = v; markDirty(tab); }, true)));
    root.append(grid);

    if (v2() && d.promptId) {
      const p = findItem("prompt", d.promptId);
      if (p) {
        const line = document.createElement("div");
        line.className = "detail-meta-line";
        const a = document.createElement("a");
        a.textContent = p.name;
        a.href = "javascript:void 0";
        a.style.color = "var(--accent)";
        a.addEventListener("click", () => openItem("prompt", p.id));
        line.append(document.createTextNode("attached to prompt: "), a);
        root.append(line);
      }
    }

    root.append(buildEditorSplit(tab, { hint: "markdown" }));

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const save = document.createElement("button");
    save.className = "btn";
    save.textContent = tab.id ? "Save (Ctrl+S)" : "Create note";
    save.addEventListener("click", () => saveNoteTab(tab));
    actions.append(save);
    if (tab.id) {
      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteNoteFlow(item));
      actions.append(del);
    }
    root.append(actions);
    return root;
  }

  // ------------------------------------------------------------------
  // Save / delete flows
  // ------------------------------------------------------------------
  async function refreshData() {
    try {
      const [prompts, notes, tags, categories] = await Promise.all([
        api.listPrompts(),
        api.listNotes(),
        api.listTags().catch(() => ({ items: [] })),
        v2() ? api.listCategories() : Promise.resolve({ items: [] }),
      ]);
      state.prompts = prompts.items || [];
      state.notes = notes.items || [];
      state.tags = (tags.items || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean);
      state.categories = categories.items || [];
      setStatusBar();
      renderAll();
    } catch (e) {
      toastError(e);
    }
  }

  function promptPayload(tab) {
    const d = tab.draft;
    const payload = {
      name: d.name.trim(),
      kind: d.kind,
      tags: csv(d.tags),
      variables: csv(d.variables),
      body: d.body,
    };
    if (v2()) {
      payload.categoryId = d.categoryId || "";
      payload.systemPromptId = d.kind === "user" ? d.systemPromptId || "" : "";
    }
    return payload;
  }

  async function savePromptTab(tab) {
    try {
      const payload = promptPayload(tab);
      let saved;
      if (tab.id) saved = await api.updatePrompt(tab.id, payload);
      else saved = await api.createPrompt(payload);
      tab.id = saved.id;
      tab.dirty = false;
      toastOk(`Prompt "${saved.name}" saved`);
      sbMsg("saved");
      await refreshData();
    } catch (e) { toastError(e); }
  }

  async function saveNoteTab(tab) {
    try {
      const d = tab.draft;
      const payload = { title: d.title.trim(), tags: csv(d.tags), body: d.body };
      if (v2()) {
        payload.categoryId = d.categoryId || "";
        payload.promptId = d.promptId || "";
      }
      let saved;
      if (tab.id) saved = await api.updateNote(tab.id, payload);
      else saved = await api.createNote(payload);
      tab.id = saved.id;
      tab.dirty = false;
      toastOk(`Note "${saved.title}" saved`);
      sbMsg("saved");
      await refreshData();
    } catch (e) { toastError(e); }
  }

  async function deletePromptFlow(prompt) {
    if (!prompt) return;
    confirmModal(`Delete prompt "${prompt.name}"?`, "Delete", async () => {
      try {
        await api.deletePrompt(prompt.id, false);
        finishDelete("prompt", prompt.id, `Prompt "${prompt.name}" deleted`);
      } catch (e) {
        if (e.envelope && e.envelope.code === "validation_failed") {
          confirmModal(
            `${e.envelope.message}\n\nForce delete and clear references?`, "Force delete",
            async () => {
              try {
                await api.deletePrompt(prompt.id, true);
                finishDelete("prompt", prompt.id, `Prompt "${prompt.name}" deleted (references cleared)`);
              } catch (e2) { toastError(e2); }
            });
        } else toastError(e);
      }
    });
  }

  async function deleteNoteFlow(note) {
    if (!note) return;
    confirmModal(`Delete note "${note.title}"?`, "Delete", async () => {
      try {
        await api.deleteNote(note.id);
        finishDelete("note", note.id, `Note "${note.title}" deleted`);
      } catch (e) { toastError(e); }
    });
  }

  function finishDelete(type, id, message) {
    const tab = state.tabs.find((t) => t.type === type && t.id === id);
    if (tab) {
      tab.dirty = false;
      closeTab(tab);
    }
    toastOk(message);
    refreshData();
  }

  // ------------------------------------------------------------------
  // Category CRUD (modal)
  // ------------------------------------------------------------------
  function showModal(build) {
    const overlay = $("modal-overlay");
    const modal = $("modal");
    modal.textContent = "";
    build(modal, () => overlay.classList.add("hidden"));
    overlay.classList.remove("hidden");
    const first = modal.querySelector("input, select, button");
    if (first) first.focus();
  }

  function confirmModal(message, actionText, onConfirm) {
    showModal((modal, close) => {
      const h = document.createElement("h2");
      h.textContent = "Confirm";
      const p = document.createElement("p");
      p.style.whiteSpace = "pre-wrap";
      p.textContent = message;
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.className = "btn secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const okBtn = document.createElement("button");
      okBtn.className = "btn danger";
      okBtn.textContent = actionText;
      okBtn.addEventListener("click", () => { close(); onConfirm(); });
      actions.append(cancel, okBtn);
      modal.append(h, p, actions);
      okBtn.focus();
    });
  }

  function categoryModal(category, presetParentId = "") {
    if (!v2()) { toast("Categories need the v2 API (or ?mock=1)", "error"); return; }
    showModal((modal, close) => {
      const h = document.createElement("h2");
      h.textContent = category ? "Edit category" : "New category";
      modal.append(h);
      const name = textInput(category ? category.name : "", "Category name", () => {});
      modal.append(field("name", name));
      const excluded = new Set();
      if (category) {
        excluded.add(category.id);
        const markDesc = (id) => state.categories.filter((c) => c.parentId === id)
          .forEach((c) => { excluded.add(c.id); markDesc(c.id); });
        markDesc(category.id);
      }
      const parentOpts = [["", "(root)"]].concat(
        categoryOptions().slice(1).filter(([id]) => !excluded.has(id))
      );
      const parent = select(parentOpts, category ? category.parentId || "" : presetParentId, () => {});
      modal.append(field("parent category", parent));
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.className = "btn secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", close);
      const save = document.createElement("button");
      save.className = "btn";
      save.textContent = category ? "Save" : "Create";
      const submit = async () => {
        const payload = { name: name.value.trim(), parentId: parent.value };
        if (!payload.name) { toast("Name is required", "error", "validation_failed"); return; }
        try {
          if (category) await api.updateCategory(category.id, payload);
          else await api.createCategory(payload);
          close();
          toastOk(`Category "${payload.name}" saved`);
          await refreshData();
        } catch (e) { toastError(e); }
      };
      save.addEventListener("click", submit);
      name.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
      actions.append(cancel, save);
      modal.append(actions);
      name.focus();
    });
  }

  function deleteCategoryFlow(category) {
    confirmModal(`Delete category "${category.name}"?`, "Delete", async () => {
      try {
        await api.deleteCategory(category.id, false);
        toastOk(`Category "${category.name}" deleted`);
        await refreshData();
      } catch (e) {
        if (e.envelope && e.envelope.code === "validation_failed") {
          confirmModal(
            `${e.envelope.message}\n\nForce delete? Children re-parent and items become uncategorized.`,
            "Force delete",
            async () => {
              try {
                await api.deleteCategory(category.id, true);
                toastOk(`Category "${category.name}" force-deleted`);
                await refreshData();
              } catch (e2) { toastError(e2); }
            });
        } else toastError(e);
      }
    });
  }

  // ------------------------------------------------------------------
  // Command palette
  // ------------------------------------------------------------------
  const palette = {
    open: false,
    selected: 0,
    entries: [],
  };

  function paletteCommands() {
    const cmds = [
      { label: "New prompt", hint: "command", run: () => openItem("prompt", null) },
      { label: "New note", hint: "command", run: () => openItem("note", null) },
      { label: "Toggle theme", hint: "command", run: toggleTheme },
      { label: "Refresh data", hint: "command", run: refreshData },
      { label: "Close active tab", hint: "command", run: () => state.activeTab && closeTab(state.activeTab) },
    ];
    if (v2()) cmds.splice(2, 0, { label: "New category", hint: "command", run: () => categoryModal(null) });
    const items = [
      ...state.prompts.map((p) => ({
        label: p.name,
        hint: promptKind(p) === "system" ? "system prompt" : "user prompt",
        run: () => openItem("prompt", p.id),
      })),
      ...state.notes.map((n) => ({ label: n.title, hint: "note", run: () => openItem("note", n.id) })),
    ];
    return [...cmds, ...items];
  }

  function openPalette() {
    palette.open = true;
    palette.selected = 0;
    $("palette-overlay").classList.remove("hidden");
    const input = $("palette-input");
    input.value = "";
    renderPalette();
    input.focus();
  }
  function closePalette() {
    palette.open = false;
    $("palette-overlay").classList.add("hidden");
  }

  function renderPalette() {
    const q = $("palette-input").value.trim().toLowerCase();
    const all = paletteCommands();
    palette.entries = q ? all.filter((e) => e.label.toLowerCase().includes(q)) : all;
    if (palette.selected >= palette.entries.length) palette.selected = 0;
    const list = $("palette-list");
    list.textContent = "";
    if (palette.entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No matches";
      list.append(li);
      return;
    }
    palette.entries.slice(0, 40).forEach((entry, i) => {
      const li = document.createElement("li");
      if (i === palette.selected) li.classList.add("selected");
      const label = document.createElement("span");
      label.textContent = entry.label;
      const hint = document.createElement("span");
      hint.className = "pl-hint";
      hint.textContent = entry.hint;
      li.append(label, hint);
      li.addEventListener("click", () => { closePalette(); entry.run(); });
      li.addEventListener("mousemove", () => {
        if (palette.selected !== i) { palette.selected = i; renderPalette(); }
      });
      list.append(li);
    });
  }

  // ------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cuenote.theme", theme);
    $("theme-picker").value = theme;
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  }
  function initTheme() {
    const saved = localStorage.getItem("cuenote.theme");
    const preferred = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(preferred === "light" ? "light" : "dark");
  }

  // ------------------------------------------------------------------
  // Global events
  // ------------------------------------------------------------------
  function bindEvents() {
    $("theme-picker").addEventListener("change", (ev) => applyTheme(ev.target.value));
    $("ab-theme").addEventListener("click", toggleTheme);
    $("ab-search").addEventListener("click", () => { $("sidebar").classList.add("open"); $("search").focus(); });
    $("ab-explorer").addEventListener("click", () => $("sidebar").classList.toggle("open"));
    $("ab-new-prompt").addEventListener("click", () => openItem("prompt", null));
    $("ab-palette").addEventListener("click", openPalette);
    $("btn-new-prompt").addEventListener("click", () => openItem("prompt", null));
    $("btn-new-note").addEventListener("click", () => openItem("note", null));
    $("btn-new-category").addEventListener("click", () => categoryModal(null));
    $("btn-refresh").addEventListener("click", () => { refreshData(); sbMsg("refreshed"); });

    $("search").addEventListener("input", (ev) => {
      state.search = ev.target.value;
      renderTree();
    });

    document.querySelectorAll("#kind-filters .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll("#kind-filters .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.kindFilter = chip.dataset.kind;
        renderTree();
      });
    });

    $("palette-input").addEventListener("input", () => { palette.selected = 0; renderPalette(); });
    $("palette-overlay").addEventListener("mousedown", (ev) => {
      if (ev.target === $("palette-overlay")) closePalette();
    });
    $("modal-overlay").addEventListener("mousedown", (ev) => {
      if (ev.target === $("modal-overlay")) $("modal-overlay").classList.add("hidden");
    });

    document.addEventListener("keydown", (ev) => {
      if (palette.open) {
        if (ev.key === "Escape") { closePalette(); ev.preventDefault(); }
        else if (ev.key === "ArrowDown") { palette.selected = Math.min(palette.selected + 1, palette.entries.length - 1); renderPalette(); ev.preventDefault(); }
        else if (ev.key === "ArrowUp") { palette.selected = Math.max(palette.selected - 1, 0); renderPalette(); ev.preventDefault(); }
        else if (ev.key === "Enter") {
          const entry = palette.entries[palette.selected];
          if (entry) { closePalette(); entry.run(); }
          ev.preventDefault();
        }
        return;
      }
      if (ev.key === "Escape" && !$("modal-overlay").classList.contains("hidden")) {
        $("modal-overlay").classList.add("hidden");
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        openPalette();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        const tab = state.activeTab;
        if (tab) (tab.type === "prompt" ? savePromptTab : saveNoteTab)(tab);
        return;
      }
      const inField = /^(input|textarea|select)$/i.test(document.activeElement.tagName);
      if (ev.key === "/" && !inField) {
        ev.preventDefault();
        $("sidebar").classList.add("open");
        $("search").focus();
        $("search").select();
      }
      if (ev.key === "w" && ev.altKey && state.activeTab) {
        ev.preventDefault();
        closeTab(state.activeTab);
      }
    });
  }

  // ------------------------------------------------------------------
  // Render root
  // ------------------------------------------------------------------
  function renderAll() {
    renderTabs();
    renderTree();
    renderTagStrip();
    renderEditorArea();
    setStatusBar();
  }

  initTheme();
  bindEvents();
  loadAll();
})();
