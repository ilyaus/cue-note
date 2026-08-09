// cue-note — vibrant glass dashboard prototype.
// Talks to the API through the webui's same-origin /api proxy (which maps
// /api/* -> /v1/* and attaches the key). Codes against the v2 contract
// (categories, prompt kinds, prompt-attached notes) and degrades gracefully
// against the v1 backend. `?mock=1` serves in-memory sample data so the full
// v2 UX is demonstrable without a v2 backend.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ */
  /* utilities                                                          */
  /* ------------------------------------------------------------------ */

  const csv = (value) =>
    value.split(",").map((s) => s.trim()).filter(Boolean);

  const escapeHTML = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // Tiny markdown renderer: headings, fenced code, inline code, bold,
  // italic, lists, links, paragraphs. Input is escaped first.
  function renderMarkdown(src) {
    const lines = escapeHTML(src || "").split("\n");
    const out = [];
    let inCode = false;
    let inList = false;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out.push(`<p>${inline(para.join(" "))}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (inList) { out.push("</ul>"); inList = false; }
    };
    const inline = (s) =>
      s.replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1</a>');
    for (const raw of lines) {
      if (raw.trim().startsWith("```")) {
        flushPara(); closeList();
        out.push(inCode ? "</code></pre>" : "<pre><code>");
        inCode = !inCode;
        continue;
      }
      if (inCode) { out.push(raw); continue; }
      const h = raw.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const level = h[1].length;
        out.push(`<h${level + 1}>${inline(h[2])}</h${level + 1}>`);
        continue;
      }
      const li = raw.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        flushPara();
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (raw.trim() === "") { flushPara(); closeList(); continue; }
      para.push(raw.trim());
    }
    if (inCode) out.push("</code></pre>");
    flushPara(); closeList();
    return out.join("\n");
  }

  function toast(message, type = "error") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    $("toasts").append(node);
    setTimeout(() => node.remove(), 4200);
  }

  function apiErrorMessage(err) {
    if (err && err.envelope) {
      const e = err.envelope;
      return `${e.message || err.message}${e.field ? ` (${e.field})` : ""}`;
    }
    return err.message || "Request failed";
  }

  const relTime = (iso) => {
    if (!iso) return "";
    const delta = Date.now() - new Date(iso).getTime();
    const mins = Math.round(delta / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(iso).toLocaleDateString();
  };

  /* ------------------------------------------------------------------ */
  /* API clients                                                        */
  /* ------------------------------------------------------------------ */

  class APIError extends Error {
    constructor(status, envelope) {
      super(envelope && envelope.message ? envelope.message : `HTTP ${status}`);
      this.status = status;
      this.envelope = envelope || null;
    }
  }

  const httpAPI = {
    async request(path, options = {}) {
      const res = await fetch(`/api${path}`, {
        ...options,
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
      });
      if (res.status === 204) return null;
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new APIError(res.status, payload && payload.error);
      return payload;
    },
    listPrompts(params) { return this.request(`/prompts${qs(params)}`); },
    getPrompt(id) { return this.request(`/prompts/${encodeURIComponent(id)}`); },
    createPrompt(body) { return this.request("/prompts", { method: "POST", body: JSON.stringify(body) }); },
    updatePrompt(id, body) { return this.request(`/prompts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }); },
    deletePrompt(id, force) { return this.request(`/prompts/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" }); },
    listNotes(params) { return this.request(`/notes${qs(params)}`); },
    getNote(id) { return this.request(`/notes/${encodeURIComponent(id)}`); },
    createNote(body) { return this.request("/notes", { method: "POST", body: JSON.stringify(body) }); },
    updateNote(id, body) { return this.request(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }); },
    deleteNote(id) { return this.request(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    listCategories() { return this.request("/categories?limit=1000"); },
    createCategory(body) { return this.request("/categories", { method: "POST", body: JSON.stringify(body) }); },
    updateCategory(id, body) { return this.request(`/categories/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }); },
    deleteCategory(id, force) { return this.request(`/categories/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" }); },
    listTags() { return this.request("/tags"); },
  };

  function qs(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === "" || value === null) continue;
      if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
      else search.set(key, String(value));
    }
    const s = search.toString();
    return s ? `?${s}` : "";
  }

  /* -------------------- mock API (?mock=1) -------------------------- */

  function buildMockAPI() {
    let seq = 0;
    const id = () => (Date.now() + ++seq).toString(16);
    const now = () => new Date().toISOString();
    const stamp = (h) => new Date(Date.now() - h * 3600e3).toISOString();

    const categories = [
      { id: "c1", name: "Coding", parentId: "", createdAt: stamp(90), updatedAt: stamp(90) },
      { id: "c2", name: "Reviews", parentId: "c1", createdAt: stamp(80), updatedAt: stamp(80) },
      { id: "c3", name: "Refactoring", parentId: "c1", createdAt: stamp(78), updatedAt: stamp(78) },
      { id: "c4", name: "Writing", parentId: "", createdAt: stamp(70), updatedAt: stamp(70) },
      { id: "c5", name: "Research", parentId: "", createdAt: stamp(66), updatedAt: stamp(66) },
    ];
    const prompts = [
      { id: "p1", name: "Senior Go reviewer", kind: "system", categoryId: "c2", systemPromptId: "", tags: ["go", "review"], body: "You are a meticulous senior Go engineer.\n\n- Review for correctness first, style second.\n- Prefer the standard library.\n- Flag any data races or unchecked errors.", variables: [], version: 3, createdAt: stamp(60), updatedAt: stamp(4) },
      { id: "p2", name: "Review my PR diff", kind: "user", categoryId: "c2", systemPromptId: "p1", tags: ["go", "review"], body: "Review the following diff for **{{repo}}**:\n\n```\n{{diff}}\n```\n\nCall out bugs, then nits.", variables: ["repo", "diff"], version: 5, createdAt: stamp(55), updatedAt: stamp(2) },
      { id: "p3", name: "Extract function refactor", kind: "user", categoryId: "c3", systemPromptId: "p1", tags: ["go", "refactor"], body: "Refactor `{{function}}` in the code below into smaller pure functions. Keep behavior identical.\n\n```\n{{code}}\n```", variables: ["function", "code"], version: 1, createdAt: stamp(50), updatedAt: stamp(30) },
      { id: "p4", name: "Concise technical writer", kind: "system", categoryId: "c4", systemPromptId: "", tags: ["writing"], body: "You write crisp, plain-language technical prose. Short sentences. No filler. Active voice.", variables: [], version: 2, createdAt: stamp(44), updatedAt: stamp(20) },
      { id: "p5", name: "Release notes from commits", kind: "user", categoryId: "c4", systemPromptId: "p4", tags: ["writing", "release"], body: "Turn these commits into user-facing release notes grouped by *Added / Changed / Fixed*:\n\n{{commits}}", variables: ["commits"], version: 2, createdAt: stamp(40), updatedAt: stamp(8) },
      { id: "p6", name: "Literature summary", kind: "user", categoryId: "c5", systemPromptId: "", tags: ["research"], body: "Summarize the key claims of the paper below in 5 bullets, then list limitations.\n\n{{paper}}", variables: ["paper"], version: 1, createdAt: stamp(35), updatedAt: stamp(35) },
      { id: "p7", name: "Brainstorm buddy", kind: "system", categoryId: "", systemPromptId: "", tags: ["ideation"], body: "You are an energetic brainstorm partner. Quantity over polish; no idea is too odd.", variables: [], version: 1, createdAt: stamp(30), updatedAt: stamp(30) },
    ];
    const notes = [
      { id: "n1", title: "Works best with gpt-4o", categoryId: "c2", tags: ["model-tips"], body: "Temperature **0.2** keeps reviews focused. Higher and it starts inventing style guides.", promptId: "p2", createdAt: stamp(20), updatedAt: stamp(3) },
      { id: "n2", title: "Add diff context", categoryId: "c2", tags: ["usage"], body: "Paste ~20 lines of surrounding context; the reviewer misses cross-function bugs without it.", promptId: "p2", createdAt: stamp(18), updatedAt: stamp(18) },
      { id: "n3", title: "Claude handles long diffs better", categoryId: "", tags: ["model-tips"], body: "For diffs > 800 lines switch models — quality holds up noticeably better.", promptId: "p1", createdAt: stamp(16), updatedAt: stamp(6) },
      { id: "n4", title: "Prompt-writing checklist", categoryId: "c4", tags: ["meta"], body: "- State the role\n- Give one example\n- Constrain the output format\n- Ask it to say *unsure* when unsure", promptId: "", createdAt: stamp(12), updatedAt: stamp(12) },
      { id: "n5", title: "Reading list: eval papers", categoryId: "c5", tags: ["research", "reading"], body: "1. *Holistic Evaluation of Language Models*\n2. *Judging LLM-as-a-Judge*", promptId: "", createdAt: stamp(10), updatedAt: stamp(1) },
    ];

    const clone = (o) => JSON.parse(JSON.stringify(o));
    const fail = (status, code, message, field) => {
      throw new APIError(status, { code, message, field });
    };
    const norm = (tags) => [...new Set((tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
    const list = (items) => ({ items: clone(items), total: items.length });
    const matches = (rec, params, text) => {
      if (params.tag) {
        const wanted = Array.isArray(params.tag) ? params.tag : [params.tag];
        if (!wanted.every((t) => (rec.tags || []).includes(t))) return false;
      }
      if (params.q && !text.toLowerCase().includes(String(params.q).toLowerCase())) return false;
      if (params.category !== undefined && params.category !== "" && (rec.categoryId || "") !== params.category) return false;
      return true;
    };

    return {
      mock: true,
      async listPrompts(params = {}) {
        return list(prompts.filter((p) => {
          if (params.kind && p.kind !== params.kind) return false;
          return matches(p, params, `${p.name} ${p.body}`);
        }));
      },
      async getPrompt(pid) {
        const p = prompts.find((x) => x.id === pid) || fail(404, "not_found", "prompt not found");
        return clone(p);
      },
      async createPrompt(body) {
        if (!body.name || !String(body.name).trim()) fail(422, "validation_failed", "name is required", "name");
        if (!body.body) fail(422, "validation_failed", "body is required", "body");
        const kind = body.kind || "user";
        if (kind !== "user" && kind !== "system") fail(422, "validation_failed", "kind must be system or user", "kind");
        if (body.systemPromptId) {
          if (kind === "system") fail(422, "validation_failed", "system prompts cannot reference a system prompt", "systemPromptId");
          const ref = prompts.find((x) => x.id === body.systemPromptId);
          if (!ref || ref.kind !== "system") fail(422, "validation_failed", "systemPromptId must reference a system prompt", "systemPromptId");
        }
        const rec = { id: id(), name: body.name.trim(), kind, categoryId: body.categoryId || "", systemPromptId: body.systemPromptId || "", tags: norm(body.tags), body: body.body, variables: body.variables || [], version: 1, createdAt: now(), updatedAt: now() };
        prompts.push(rec);
        return clone(rec);
      },
      async updatePrompt(pid, body) {
        const rec = prompts.find((x) => x.id === pid) || fail(404, "not_found", "prompt not found");
        const next = { ...rec, ...body, tags: norm(body.tags ?? rec.tags) };
        if (next.kind === "system" && next.systemPromptId) fail(422, "validation_failed", "system prompts cannot reference a system prompt", "systemPromptId");
        if (next.kind === "system") {
          // becoming/staying system is fine; references to it stay valid
        } else if (next.systemPromptId) {
          const ref = prompts.find((x) => x.id === next.systemPromptId);
          if (!ref || ref.kind !== "system") fail(422, "validation_failed", "systemPromptId must reference a system prompt", "systemPromptId");
        }
        Object.assign(rec, next, { version: rec.version + 1, updatedAt: now() });
        return clone(rec);
      },
      async deletePrompt(pid, force) {
        const idx = prompts.findIndex((x) => x.id === pid);
        if (idx < 0) fail(404, "not_found", "prompt not found");
        const referencing = prompts.filter((x) => x.systemPromptId === pid);
        if (referencing.length && !force) fail(422, "validation_failed", `referenced by ${referencing.length} user prompt(s); use force`, "id");
        referencing.forEach((x) => { x.systemPromptId = ""; });
        notes.forEach((n) => { if (n.promptId === pid) n.promptId = ""; });
        prompts.splice(idx, 1);
        return null;
      },
      async listNotes(params = {}) {
        return list(notes.filter((n) => {
          if (params.prompt && n.promptId !== params.prompt) return false;
          return matches(n, params, `${n.title} ${n.body}`);
        }));
      },
      async getNote(nid) {
        const n = notes.find((x) => x.id === nid) || fail(404, "not_found", "note not found");
        return clone(n);
      },
      async createNote(body) {
        if (!body.title || !String(body.title).trim()) fail(422, "validation_failed", "title is required", "title");
        const rec = { id: id(), title: body.title.trim(), categoryId: body.categoryId || "", tags: norm(body.tags), body: body.body || "", promptId: body.promptId || "", createdAt: now(), updatedAt: now() };
        notes.push(rec);
        return clone(rec);
      },
      async updateNote(nid, body) {
        const rec = notes.find((x) => x.id === nid) || fail(404, "not_found", "note not found");
        Object.assign(rec, body, { tags: norm(body.tags ?? rec.tags), updatedAt: now() });
        return clone(rec);
      },
      async deleteNote(nid) {
        const idx = notes.findIndex((x) => x.id === nid);
        if (idx < 0) fail(404, "not_found", "note not found");
        notes.splice(idx, 1);
        return null;
      },
      async listCategories() { return list(categories); },
      async createCategory(body) {
        if (!body.name || !String(body.name).trim()) fail(422, "validation_failed", "name is required", "name");
        const rec = { id: id(), name: body.name.trim(), parentId: body.parentId || "", createdAt: now(), updatedAt: now() };
        categories.push(rec);
        return clone(rec);
      },
      async updateCategory(cid, body) {
        const rec = categories.find((x) => x.id === cid) || fail(404, "not_found", "category not found");
        Object.assign(rec, body, { updatedAt: now() });
        return clone(rec);
      },
      async deleteCategory(cid, force) {
        const idx = categories.findIndex((x) => x.id === cid);
        if (idx < 0) fail(404, "not_found", "category not found");
        const rec = categories[idx];
        const busy = categories.some((c) => c.parentId === cid) ||
          prompts.some((p) => p.categoryId === cid) || notes.some((n) => n.categoryId === cid);
        if (busy && !force) fail(422, "validation_failed", "category is not empty; use force", "id");
        categories.forEach((c) => { if (c.parentId === cid) c.parentId = rec.parentId; });
        prompts.forEach((p) => { if (p.categoryId === cid) p.categoryId = ""; });
        notes.forEach((n) => { if (n.categoryId === cid) n.categoryId = ""; });
        categories.splice(idx, 1);
        return null;
      },
      async listTags() {
        const count = (items) => {
          const map = new Map();
          items.forEach((r) => (r.tags || []).forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
          return [...map.entries()].sort().map(([tag, c]) => ({ tag, count: c }));
        };
        return { prompts: count(prompts), notes: count(notes) };
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */

  const mockMode = new URLSearchParams(location.search).get("mock") === "1";
  const api = mockMode ? buildMockAPI() : httpAPI;

  const state = {
    v2: mockMode, // whether the backend supports categories/kind
    categories: [],
    prompts: [],
    notes: [],
    tags: [],
    filter: { view: "all", categoryId: null, tag: null, q: "" },
    expanded: new Set(),
    detail: null, // {type, record}
  };

  /* ------------------------------------------------------------------ */
  /* data loading                                                       */
  /* ------------------------------------------------------------------ */

  async function detectV2() {
    if (mockMode) return true;
    try {
      await api.listCategories();
      return true;
    } catch (err) {
      if (err instanceof APIError && (err.status === 404 || err.status === 405)) return false;
      if (err instanceof APIError) return false;
      throw err;
    }
  }

  async function loadAll() {
    $("loading").hidden = false;
    try {
      const [promptPage, notePage, tags, catPage] = await Promise.all([
        api.listPrompts({ limit: 1000 }),
        api.listNotes({ limit: 1000 }),
        api.listTags().catch(() => ({ prompts: [], notes: [] })),
        state.v2 ? api.listCategories().catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      ]);
      state.prompts = (promptPage.items || []).map((p) => ({ ...p, kind: p.kind || "user" }));
      state.notes = notePage.items || [];
      state.categories = catPage.items || [];
      const tagMap = new Map();
      [...(tags.prompts || []), ...(tags.notes || [])].forEach((e) => {
        tagMap.set(e.tag, (tagMap.get(e.tag) || 0) + e.count);
      });
      state.tags = [...tagMap.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
      renderAll();
    } catch (err) {
      toast(apiErrorMessage(err));
    } finally {
      $("loading").hidden = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* filtering                                                          */
  /* ------------------------------------------------------------------ */

  function itemMatchesFilter(item, type) {
    const f = state.filter;
    if (f.view === "prompts" && type !== "prompt") return false;
    if (f.view === "notes" && type !== "note") return false;
    if (f.view === "system" && !(type === "prompt" && item.kind === "system")) return false;
    if (f.view === "user" && !(type === "prompt" && item.kind === "user")) return false;
    if (f.categoryId !== null) {
      if (f.categoryId === "") { if (item.categoryId) return false; }
      else if ((item.categoryId || "") !== f.categoryId) return false;
    }
    if (f.tag && !(item.tags || []).includes(f.tag)) return false;
    if (f.q) {
      const hay = `${item.name || ""} ${item.title || ""} ${item.body || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  function visibleItems() {
    const out = [];
    state.prompts.forEach((p) => { if (itemMatchesFilter(p, "prompt")) out.push({ type: "prompt", record: p }); });
    state.notes.forEach((n) => { if (itemMatchesFilter(n, "note")) out.push({ type: "note", record: n }); });
    out.sort((a, b) => (b.record.updatedAt || "").localeCompare(a.record.updatedAt || ""));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* rendering: sidebar tree                                            */
  /* ------------------------------------------------------------------ */

  function countInCategory(catId) {
    const inCat = (x) => (x.categoryId || "") === catId;
    return state.prompts.filter(inCat).length + state.notes.filter(inCat).length;
  }

  function treeButton({ label, count, current, depth = 0, twisty = null, onClick, actions = [] }) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tree-item";
    btn.style.paddingLeft = `${10 + depth * 14}px`;
    btn.setAttribute("aria-current", String(!!current));
    if (twisty) {
      const tw = document.createElement("span");
      tw.className = `twisty${twisty.open ? " open" : ""}`;
      tw.textContent = twisty.leaf ? "" : "▶";
      tw.addEventListener("click", (e) => { e.stopPropagation(); twisty.toggle(); });
      btn.append(tw);
    }
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = label;
    btn.append(lab);
    for (const act of actions) {
      const wrap = document.createElement("span");
      wrap.className = "cat-actions";
      const a = document.createElement("span");
      a.className = "icon-btn";
      a.style.width = a.style.height = "20px";
      a.style.fontSize = "11px";
      a.style.display = "inline-flex";
      a.style.alignItems = "center";
      a.style.justifyContent = "center";
      a.textContent = act.icon;
      a.title = act.title;
      a.addEventListener("click", (e) => { e.stopPropagation(); act.onClick(); });
      wrap.append(a);
      btn.append(wrap);
    }
    if (count !== undefined) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(count);
      btn.append(badge);
    }
    btn.addEventListener("click", onClick);
    li.append(btn);
    return li;
  }

  function renderLibrary() {
    const root = $("tree-root");
    root.textContent = "";
    const f = state.filter;
    const entries = [
      { view: "all", label: "All items", count: state.prompts.length + state.notes.length },
      { view: "prompts", label: "Prompts", count: state.prompts.length },
    ];
    if (state.v2) {
      entries.push(
        { view: "system", label: "· System prompts", count: state.prompts.filter((p) => p.kind === "system").length },
        { view: "user", label: "· User prompts", count: state.prompts.filter((p) => p.kind === "user").length },
      );
    }
    entries.push({ view: "notes", label: "Notes", count: state.notes.length });
    for (const e of entries) {
      root.append(treeButton({
        label: e.label,
        count: e.count,
        current: f.view === e.view && f.categoryId === null,
        onClick: () => { f.view = e.view; f.categoryId = null; renderAll(); },
      }));
    }
  }

  function renderCategories() {
    const section = $("categories-section");
    section.hidden = !state.v2;
    if (!state.v2) return;
    const rootUl = $("tree-categories");
    rootUl.textContent = "";
    const byParent = new Map();
    state.categories.forEach((c) => {
      const key = c.parentId || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    });
    byParent.forEach((arr) => arr.sort((a, b) => a.name.localeCompare(b.name)));

    const renderLevel = (parentId, depth, ul) => {
      for (const cat of byParent.get(parentId) || []) {
        const kids = byParent.get(cat.id) || [];
        const open = state.expanded.has(cat.id);
        ul.append(treeButton({
          label: cat.name,
          count: countInCategory(cat.id),
          depth,
          current: state.filter.categoryId === cat.id,
          twisty: {
            leaf: kids.length === 0,
            open,
            toggle: () => {
              if (open) state.expanded.delete(cat.id); else state.expanded.add(cat.id);
              renderCategories();
            },
          },
          actions: [
            { icon: "✎", title: "Rename", onClick: () => renameCategory(cat) },
            { icon: "＋", title: "New subcategory", onClick: () => createCategory(cat.id) },
            { icon: "🗑", title: "Delete", onClick: () => deleteCategory(cat) },
          ],
          onClick: () => { state.filter.categoryId = cat.id; renderAll(); },
        }));
        if (kids.length && open) renderLevel(cat.id, depth + 1, ul);
      }
    };
    renderLevel("", 0, rootUl);

    rootUl.append(treeButton({
      label: "Uncategorized",
      count: countInCategory(""),
      current: state.filter.categoryId === "",
      onClick: () => { state.filter.categoryId = ""; renderAll(); },
    }));
  }

  function renderTags() {
    const ul = $("tag-chips");
    ul.textContent = "";
    for (const { tag, count } of state.tags.slice(0, 24)) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = `#${tag} ${count}`;
      btn.setAttribute("aria-pressed", String(state.filter.tag === tag));
      btn.addEventListener("click", () => {
        state.filter.tag = state.filter.tag === tag ? null : tag;
        renderAll();
      });
      li.append(btn);
      ul.append(li);
    }
    if (!state.tags.length) {
      const li = document.createElement("li");
      li.style.cssText = "color:var(--text-dim);font-size:12px;padding:2px 6px;";
      li.textContent = "No tags yet";
      ul.append(li);
    }
  }

  /* ------------------------------------------------------------------ */
  /* rendering: cards                                                   */
  /* ------------------------------------------------------------------ */

  function categoryName(id) {
    const c = state.categories.find((x) => x.id === id);
    return c ? c.name : "";
  }

  function kindPill(item, type) {
    const span = document.createElement("span");
    span.className = `kind-pill ${type === "note" ? "note" : item.kind}`;
    span.textContent = type === "note" ? "note" : item.kind;
    return span;
  }

  function renderCrumb() {
    const f = state.filter;
    const parts = [];
    if (f.categoryId === "") parts.push("Uncategorized");
    else if (f.categoryId) parts.push(categoryName(f.categoryId) || "Category");
    else {
      parts.push({ all: "All items", prompts: "Prompts", notes: "Notes", system: "System prompts", user: "User prompts" }[f.view]);
    }
    if (f.tag) parts.push(`#${f.tag}`);
    if (f.q) parts.push(`“${f.q}”`);
    $("crumb").textContent = parts.join("  ·  ");
  }

  function renderGrid() {
    const grid = $("grid");
    grid.textContent = "";
    const items = visibleItems();
    $("count-badge").textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;
    $("empty-state").hidden = items.length > 0;
    for (const { type, record } of items) {
      const card = document.createElement("article");
      card.className = "card glass";
      const top = document.createElement("div");
      top.className = "card-top";
      top.append(kindPill(record, type));
      if (state.v2 && record.categoryId) {
        const cat = document.createElement("span");
        cat.className = "badge";
        cat.textContent = categoryName(record.categoryId);
        top.append(cat);
      }
      const h = document.createElement("h3");
      h.textContent = record.name || record.title || "(untitled)";
      const ex = document.createElement("p");
      ex.className = "excerpt";
      ex.textContent = (record.body || "").slice(0, 320);
      const tags = document.createElement("div");
      tags.className = "card-tags";
      (record.tags || []).forEach((t) => {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = `#${t}`;
        tags.append(s);
      });
      const foot = document.createElement("div");
      foot.className = "card-foot";
      const bits = [relTime(record.updatedAt)];
      if (type === "prompt") {
        bits.push(`v${record.version}`);
        const attached = state.notes.filter((n) => n.promptId === record.id).length;
        if (attached) bits.push(`📎 ${attached} note${attached === 1 ? "" : "s"}`);
      }
      foot.textContent = bits.filter(Boolean).join(" · ");
      card.append(top, h, ex, tags, foot);
      card.addEventListener("click", () => openDetail(type, record.id));
      grid.append(card);
    }
  }

  function renderAll() {
    renderLibrary();
    renderCategories();
    renderTags();
    renderCrumb();
    renderGrid();
  }

  /* ------------------------------------------------------------------ */
  /* detail slide-over                                                  */
  /* ------------------------------------------------------------------ */

  function closePanels() {
    $("detail").hidden = true;
    $("editor").hidden = true;
    $("overlay").hidden = true;
    state.detail = null;
  }

  async function openDetail(type, id) {
    try {
      const record = type === "prompt" ? await api.getPrompt(id) : await api.getNote(id);
      if (type === "prompt" && !record.kind) record.kind = "user";
      state.detail = { type, record };
      renderDetail();
      $("editor").hidden = true;
      $("detail").hidden = false;
      $("overlay").hidden = false;
    } catch (err) {
      toast(apiErrorMessage(err));
    }
  }

  function renderDetail() {
    const { type, record } = state.detail;
    const head = $("detail-kind");
    head.textContent = "";
    head.append(kindPill(record, type));
    const title = document.createElement("span");
    title.textContent = type === "prompt" ? "Prompt" : "Note";
    head.append(title);

    const body = $("detail-body");
    body.textContent = "";

    const h2 = document.createElement("h2");
    h2.textContent = record.name || record.title || "(untitled)";
    body.append(h2);

    const meta = document.createElement("div");
    meta.className = "detail-meta";
    const metaBits = [];
    if (type === "prompt") metaBits.push(`version ${record.version}`);
    if (state.v2 && record.categoryId) metaBits.push(`📁 ${categoryName(record.categoryId)}`);
    metaBits.push(`updated ${relTime(record.updatedAt)}`);
    (record.tags || []).forEach((t) => metaBits.push(`#${t}`));
    meta.textContent = metaBits.join("  ·  ");
    body.append(meta);

    // user prompt -> linked system prompt with inline preview
    if (type === "prompt" && record.kind === "user" && record.systemPromptId) {
      const sys = state.prompts.find((p) => p.id === record.systemPromptId);
      const section = document.createElement("div");
      section.className = "detail-section";
      section.innerHTML = "<h4>System prompt</h4>";
      const box = document.createElement("div");
      box.className = "linked-prompt";
      if (sys) {
        const headRow = document.createElement("div");
        headRow.className = "lp-head";
        headRow.append(kindPill(sys, "prompt"));
        const link = document.createElement("a");
        link.textContent = sys.name;
        link.addEventListener("click", () => openDetail("prompt", sys.id));
        headRow.append(link);
        const pre = document.createElement("pre");
        pre.textContent = sys.body;
        box.append(headRow, pre);
      } else {
        box.textContent = "Referenced system prompt not found.";
      }
      section.append(box);
      body.append(section);
    }

    // body (markdown)
    const bodySection = document.createElement("div");
    bodySection.className = "detail-section";
    bodySection.innerHTML = "<h4>Body</h4>";
    const md = document.createElement("div");
    md.className = "detail-md";
    md.innerHTML = renderMarkdown(record.body || "");
    bodySection.append(md);
    body.append(bodySection);

    if (type === "prompt" && (record.variables || []).length) {
      const vs = document.createElement("div");
      vs.className = "detail-section";
      vs.innerHTML = "<h4>Variables</h4>";
      const wrap = document.createElement("div");
      record.variables.forEach((v) => {
        const pill = document.createElement("span");
        pill.className = "var-pill";
        pill.textContent = `{{${v}}}`;
        wrap.append(pill);
      });
      vs.append(wrap);
      body.append(vs);
    }

    // attached notes for prompts
    if (type === "prompt") {
      const section = document.createElement("div");
      section.className = "detail-section";
      const attached = state.notes.filter((n) => n.promptId === record.id);
      section.innerHTML = `<h4>Attached notes (${attached.length})</h4>`;
      for (const note of attached) {
        const item = document.createElement("div");
        item.className = "note-item";
        const headRow = document.createElement("div");
        headRow.className = "ni-head";
        const strong = document.createElement("strong");
        strong.textContent = note.title;
        strong.title = "Open note";
        strong.addEventListener("click", () => openDetail("note", note.id));
        const actions = document.createElement("div");
        actions.className = "ni-actions";
        const edit = document.createElement("button");
        edit.className = "pill-btn small";
        edit.type = "button";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openEditor("note", note));
        const detach = document.createElement("button");
        detach.className = "pill-btn small";
        detach.type = "button";
        detach.textContent = "Detach";
        detach.addEventListener("click", async () => {
          try {
            await api.updateNote(note.id, { ...note, promptId: "" });
            toast("Note detached", "ok");
            await loadAll();
            await openDetail("prompt", record.id);
          } catch (err) { toast(apiErrorMessage(err)); }
        });
        actions.append(edit, detach);
        headRow.append(strong, actions);
        const nb = document.createElement("div");
        nb.className = "ni-body";
        nb.textContent = (note.body || "").slice(0, 160);
        item.append(headRow, nb);
        section.append(item);
      }
      const addRow = document.createElement("div");
      addRow.className = "add-note-row";
      const addBtn = document.createElement("button");
      addBtn.className = "pill-btn small";
      addBtn.type = "button";
      addBtn.textContent = "＋ Attach new note";
      addBtn.addEventListener("click", () => {
        openEditor("note", { promptId: record.id, categoryId: record.categoryId || "" });
      });
      addRow.append(addBtn);
      const existing = state.notes.filter((n) => !n.promptId);
      if (existing.length) {
        const sel = document.createElement("select");
        sel.style.flex = "1";
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = "Attach existing note…";
        sel.append(opt0);
        existing.forEach((n) => {
          const o = document.createElement("option");
          o.value = n.id;
          o.textContent = n.title;
          sel.append(o);
        });
        sel.addEventListener("change", async () => {
          if (!sel.value) return;
          const note = state.notes.find((n) => n.id === sel.value);
          try {
            await api.updateNote(note.id, { ...note, promptId: record.id });
            toast("Note attached", "ok");
            await loadAll();
            await openDetail("prompt", record.id);
          } catch (err) { toast(apiErrorMessage(err)); }
        });
        addRow.append(sel);
      }
      section.append(addRow);
      body.append(section);
    }

    // note attached to a prompt -> show link back
    if (type === "note" && record.promptId) {
      const p = state.prompts.find((x) => x.id === record.promptId);
      const section = document.createElement("div");
      section.className = "detail-section";
      section.innerHTML = "<h4>Attached to prompt</h4>";
      const box = document.createElement("div");
      box.className = "linked-prompt";
      if (p) {
        const headRow = document.createElement("div");
        headRow.className = "lp-head";
        headRow.append(kindPill(p, "prompt"));
        const link = document.createElement("a");
        link.textContent = p.name;
        link.addEventListener("click", () => openDetail("prompt", p.id));
        headRow.append(link);
        box.append(headRow);
      } else {
        box.textContent = "Prompt not found.";
      }
      section.append(box);
      body.append(section);
    }
  }

  /* ------------------------------------------------------------------ */
  /* editor                                                             */
  /* ------------------------------------------------------------------ */

  function fillCategorySelect(sel, current) {
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— uncategorized —";
    sel.append(none);
    const byParent = new Map();
    state.categories.forEach((c) => {
      const key = c.parentId || "";
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(c);
    });
    const walk = (parentId, depth) => {
      for (const c of (byParent.get(parentId) || []).sort((a, b) => a.name.localeCompare(b.name))) {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = `${"  ".repeat(depth)}${c.name}`;
        sel.append(o);
        walk(c.id, depth + 1);
      }
    };
    walk("", 0);
    sel.value = current || "";
  }

  function fillSystemSelect(sel, current, excludeId) {
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    sel.append(none);
    state.prompts.filter((p) => p.kind === "system" && p.id !== excludeId).forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.append(o);
    });
    sel.value = current || "";
  }

  function fillAttachSelect(sel, current) {
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— standalone note —";
    sel.append(none);
    state.prompts.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.append(o);
    });
    sel.value = current || "";
  }

  function openEditor(type, record = {}) {
    $("detail").hidden = true;
    $("editor-title").textContent = `${record.id ? "Edit" : "New"} ${type}`;
    $("f-id").value = record.id || "";
    $("f-type").value = type;
    $("f-name").value = record.name || record.title || "";
    $("f-tags").value = (record.tags || []).join(", ");
    $("f-body").value = record.body || "";
    $("f-preview").hidden = true;
    $("f-body").hidden = false;
    $("preview-toggle").textContent = "Preview";

    const isPrompt = type === "prompt";
    $("f-kind-field").hidden = !isPrompt || !state.v2;
    $("f-vars-field").hidden = !isPrompt;
    $("f-attach-field").hidden = isPrompt || !state.v2;
    $("f-category-field").hidden = !state.v2;
    if (isPrompt) {
      $("f-kind").value = record.kind || "user";
      $("f-vars").value = (record.variables || []).join(", ");
      fillSystemSelect($("f-system"), record.systemPromptId, record.id);
      syncKindField();
    } else {
      $("f-system-field").hidden = true;
      fillAttachSelect($("f-attach"), record.promptId);
    }
    if (state.v2) fillCategorySelect($("f-category"), record.categoryId);

    $("editor").hidden = false;
    $("overlay").hidden = false;
    $("f-name").focus();
  }

  function syncKindField() {
    const isPrompt = $("f-type").value === "prompt";
    $("f-system-field").hidden = !isPrompt || !state.v2 || $("f-kind").value !== "user";
  }

  async function submitEditor(event) {
    event.preventDefault();
    const type = $("f-type").value;
    const id = $("f-id").value;
    try {
      let saved;
      if (type === "prompt") {
        const payload = {
          name: $("f-name").value,
          tags: csv($("f-tags").value),
          body: $("f-body").value,
          variables: csv($("f-vars").value),
        };
        if (state.v2) {
          payload.kind = $("f-kind").value;
          payload.categoryId = $("f-category").value;
          payload.systemPromptId = payload.kind === "user" ? $("f-system").value : "";
        }
        saved = id ? await api.updatePrompt(id, payload) : await api.createPrompt(payload);
      } else {
        const payload = {
          title: $("f-name").value,
          tags: csv($("f-tags").value),
          body: $("f-body").value,
          promptId: state.v2 ? $("f-attach").value : "",
        };
        if (state.v2) payload.categoryId = $("f-category").value;
        saved = id ? await api.updateNote(id, payload) : await api.createNote(payload);
      }
      toast(id ? "Saved" : "Created", "ok");
      await loadAll();
      await openDetail(type, saved.id);
    } catch (err) {
      toast(apiErrorMessage(err));
    }
  }

  /* ------------------------------------------------------------------ */
  /* category CRUD                                                      */
  /* ------------------------------------------------------------------ */

  async function createCategory(parentId = "") {
    const name = window.prompt(parentId ? "New subcategory name:" : "New category name:");
    if (!name || !name.trim()) return;
    try {
      await api.createCategory({ name: name.trim(), parentId });
      if (parentId) state.expanded.add(parentId);
      toast("Category created", "ok");
      await loadAll();
    } catch (err) { toast(apiErrorMessage(err)); }
  }

  async function renameCategory(cat) {
    const name = window.prompt("Rename category:", cat.name);
    if (!name || !name.trim() || name.trim() === cat.name) return;
    try {
      await api.updateCategory(cat.id, { ...cat, name: name.trim() });
      toast("Category renamed", "ok");
      await loadAll();
    } catch (err) { toast(apiErrorMessage(err)); }
  }

  async function deleteCategory(cat) {
    if (!window.confirm(`Delete category “${cat.name}”?`)) return;
    try {
      await api.deleteCategory(cat.id, false);
    } catch (err) {
      if (err instanceof APIError && err.envelope && err.envelope.code === "validation_failed") {
        if (!window.confirm("Category is not empty. Force delete? Children are re-parented and items become uncategorized.")) return;
        try { await api.deleteCategory(cat.id, true); } catch (err2) { toast(apiErrorMessage(err2)); return; }
      } else { toast(apiErrorMessage(err)); return; }
    }
    if (state.filter.categoryId === cat.id) state.filter.categoryId = null;
    toast("Category deleted", "ok");
    await loadAll();
  }

  /* ------------------------------------------------------------------ */
  /* delete record                                                      */
  /* ------------------------------------------------------------------ */

  async function deleteCurrent() {
    const { type, record } = state.detail || {};
    if (!record) return;
    const label = record.name || record.title;
    if (!window.confirm(`Delete ${type} “${label}”?`)) return;
    try {
      if (type === "prompt") {
        try {
          await api.deletePrompt(record.id, false);
        } catch (err) {
          if (err instanceof APIError && err.envelope && err.envelope.code === "validation_failed") {
            if (!window.confirm("This system prompt is referenced by user prompts. Force delete and clear references?")) return;
            await api.deletePrompt(record.id, true);
          } else throw err;
        }
      } else {
        await api.deleteNote(record.id);
      }
      toast("Deleted", "ok");
      closePanels();
      await loadAll();
    } catch (err) { toast(apiErrorMessage(err)); }
  }

  /* ------------------------------------------------------------------ */
  /* theme                                                              */
  /* ------------------------------------------------------------------ */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cue-note-theme", theme);
    $("theme-icon").textContent = theme === "dark" ? "☾" : "☀";
    $("theme-label").textContent = theme === "dark" ? "Aurora" : "Light";
  }

  function applyAccent(accent) {
    document.documentElement.dataset.accent = accent;
    localStorage.setItem("cue-note-accent", accent);
    document.querySelectorAll(".accent-dot").forEach((d) =>
      d.setAttribute("aria-pressed", String(d.dataset.accent === accent)));
  }

  function initTheme() {
    const saved = localStorage.getItem("cue-note-theme");
    const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    applyTheme(saved || system);
    applyAccent(localStorage.getItem("cue-note-accent") || "aurora");
  }

  /* ------------------------------------------------------------------ */
  /* command palette                                                    */
  /* ------------------------------------------------------------------ */

  function paletteCommands() {
    const cmds = [
      { label: "＋ New prompt", hint: "create", run: () => openEditor("prompt", {}) },
      { label: "＋ New note", hint: "create", run: () => openEditor("note", {}) },
      { label: "◐ Toggle theme", hint: "theme", run: () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark") },
      { label: "⌕ Focus search", hint: "/", run: () => $("search").focus() },
    ];
    if (state.v2) cmds.splice(2, 0, { label: "＋ New category", hint: "create", run: () => createCategory("") });
    state.prompts.forEach((p) => cmds.push({ label: `→ ${p.name}`, hint: p.kind, run: () => openDetail("prompt", p.id) }));
    state.notes.forEach((n) => cmds.push({ label: `→ ${n.title}`, hint: "note", run: () => openDetail("note", n.id) }));
    return cmds;
  }

  let paletteIndex = 0;
  function renderPalette() {
    const q = $("palette-input").value.toLowerCase();
    const list = $("palette-list");
    list.textContent = "";
    const matches = paletteCommands().filter((c) => c.label.toLowerCase().includes(q)).slice(0, 12);
    matches.forEach((cmd, i) => {
      const li = document.createElement("li");
      li.setAttribute("aria-selected", String(i === paletteIndex));
      const label = document.createElement("span");
      label.textContent = cmd.label;
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = cmd.hint;
      li.append(label, hint);
      li.addEventListener("click", () => { closePalette(); cmd.run(); });
      list.append(li);
    });
    return matches;
  }

  function openPalette() {
    paletteIndex = 0;
    $("palette").hidden = false;
    $("palette-input").value = "";
    renderPalette();
    $("palette-input").focus();
  }
  function closePalette() { $("palette").hidden = true; }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  function wire() {
    $("theme-toggle").addEventListener("click", () =>
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    document.querySelectorAll(".accent-dot").forEach((d) =>
      d.addEventListener("click", () => applyAccent(d.dataset.accent)));

    let searchTimer;
    $("search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.q = $("search").value.trim();
        renderAll();
      }, 150);
    });

    $("new-prompt").addEventListener("click", () => openEditor("prompt", { categoryId: state.filter.categoryId || "" }));
    $("new-note").addEventListener("click", () => openEditor("note", { categoryId: state.filter.categoryId || "" }));
    $("new-category").addEventListener("click", () => createCategory(""));

    $("overlay").addEventListener("click", closePanels);
    $("detail-close").addEventListener("click", closePanels);
    $("editor-close").addEventListener("click", closePanels);
    $("editor-cancel").addEventListener("click", closePanels);
    $("detail-edit").addEventListener("click", () => {
      const { type, record } = state.detail;
      openEditor(type, record);
    });
    $("detail-delete").addEventListener("click", deleteCurrent);
    $("editor-form").addEventListener("submit", submitEditor);
    $("f-kind").addEventListener("change", syncKindField);

    $("preview-toggle").addEventListener("click", () => {
      const preview = $("f-preview");
      const showing = !preview.hidden;
      preview.hidden = showing;
      $("f-body").hidden = !showing;
      $("preview-toggle").textContent = showing ? "Preview" : "Edit";
      if (!showing) preview.innerHTML = renderMarkdown($("f-body").value);
    });

    $("palette-input").addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
    $("palette-input").addEventListener("keydown", (e) => {
      const matches = paletteCommands().filter((c) =>
        c.label.toLowerCase().includes($("palette-input").value.toLowerCase())).slice(0, 12);
      if (e.key === "ArrowDown") { e.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, matches.length - 1); renderPalette(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); }
      else if (e.key === "Enter") { e.preventDefault(); const cmd = matches[paletteIndex]; if (cmd) { closePalette(); cmd.run(); } }
    });
    $("palette").addEventListener("click", (e) => { if (e.target === $("palette")) closePalette(); });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing) { e.preventDefault(); $("search").focus(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
      else if (e.key === "Escape") {
        if (!$("palette").hidden) closePalette();
        else closePanels();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  async function boot() {
    initTheme();
    wire();
    try {
      state.v2 = await detectV2();
    } catch (err) {
      state.v2 = false;
    }
    $("api-mode").textContent = mockMode
      ? "mock data · full v2 preview"
      : state.v2 ? "connected · v2 API" : "connected · v1 API (categories unavailable)";
    if (!state.v2) $("categories-section").hidden = true;
    await loadAll();
  }

  void boot();
})();
