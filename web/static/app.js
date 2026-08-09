/* cue-note — Notion-inspired document workspace.
   Dependency-free vanilla JS single-page app.

   Talks to same-origin /api/v1 (the webui proxy injects auth). Codes against
   the v2 contract (categories, prompt kinds, prompt-attached notes) and
   degrades gracefully against a v1 backend by feature detection. `?mock=1`
   serves in-memory sample data so the full v2 UX is demonstrable offline. */

"use strict";

/* ============================== utilities ============================== */

const $ = (sel, root) => (root || document).querySelector(sel);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k in el && k !== "list" && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function snippet(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}

function parseTags(s) {
  return [...new Set(String(s || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean))].sort();
}

/* ======================= tiny Markdown renderer ======================== */

function renderInline(text) {
  let s = escapeHTML(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => "<code>" + c + "</code>");
  s = s.replace(/\{\{([\w.-]+)\}\}/g, (_, v) => '<span class="var-token">{{' + v + "}}</span>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = [];
  let i = 0;
  let listType = null;
  const closeList = () => { if (listType) { out.push("</" + listType + ">"); listType = null; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push("<pre><code>" + escapeHTML(buf.join("\n")) + "</code></pre>");
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const lvl = heading[1].length;
      out.push("<h" + lvl + ">" + renderInline(heading[2]) + "</h" + lvl + ">");
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out.push("<hr />"); i++; continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      const buf = [quote[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push("<blockquote>" + buf.map(renderInline).join("<br />") + "</blockquote>");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) { closeList(); out.push("<" + want + ">"); listType = want; }
      out.push("<li>" + renderInline((ul || ol)[1]) + "</li>");
      i++;
      continue;
    }
    if (line.trim() === "") { closeList(); i++; continue; }
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
      !/^(#{1,3}\s|```|>\s?|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push("<p>" + buf.map(renderInline).join("<br />") + "</p>");
  }
  closeList();
  return out.join("\n");
}

/* ============================ API adapters ============================= */

class APIError extends Error {
  constructor(code, message, field, status) {
    super(message);
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

async function apiFetch(path, options) {
  let res;
  try {
    res = await fetch("/api" + path, options);
  } catch (err) {
    throw new APIError("network_error", "Cannot reach the cue-note server.", "", 0);
  }
  if (res.status === 204) return null;
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = body && body.error ? body.error : {};
    throw new APIError(e.code || "internal_error",
      e.message || res.statusText || "Request failed", e.field || "", res.status);
  }
  return body;
}

const RealBackend = {
  async detect() {
    try {
      await apiFetch("/categories?limit=1");
      return { categories: true };
    } catch (err) {
      if (err.status === 0) throw err;
      return { categories: false };
    }
  },
  listPrompts: () => apiFetch("/prompts?limit=1000").then((r) => r.items || []),
  listNotes: () => apiFetch("/notes?limit=1000").then((r) => r.items || []),
  listCategories: () => apiFetch("/categories?limit=1000").then((r) => r.items || []),
  createPrompt: (input) => apiFetch("/prompts", { method: "POST", body: JSON.stringify(input) }),
  updatePrompt: (id, input) => apiFetch("/prompts/" + id, { method: "PUT", body: JSON.stringify(input) }),
  deletePrompt: (id, force) => apiFetch("/prompts/" + id + (force ? "?force=true" : ""), { method: "DELETE" }),
  createNote: (input) => apiFetch("/notes", { method: "POST", body: JSON.stringify(input) }),
  updateNote: (id, input) => apiFetch("/notes/" + id, { method: "PUT", body: JSON.stringify(input) }),
  deleteNote: (id) => apiFetch("/notes/" + id, { method: "DELETE" }),
  createCategory: (input) => apiFetch("/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (id, input) => apiFetch("/categories/" + id, { method: "PUT", body: JSON.stringify(input) }),
  deleteCategory: (id, force) => apiFetch("/categories/" + id + (force ? "?force=true" : ""), { method: "DELETE" }),
};

/* ------------------------------ mock mode ------------------------------ */

function makeMockBackend() {
  let seq = 100;
  const id = () => "mock" + (seq++).toString(16).padStart(8, "0");
  const now = () => new Date().toISOString();
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();

  const cats = [
    { id: "cat-writing", name: "Writing", parentId: "", icon: "" },
    { id: "cat-blog", name: "Blog posts", parentId: "cat-writing", icon: "" },
    { id: "cat-email", name: "Email", parentId: "cat-writing", icon: "" },
    { id: "cat-coding", name: "Coding", parentId: "", icon: "" },
    { id: "cat-review", name: "Code review", parentId: "cat-coding", icon: "" },
    { id: "cat-research", name: "Research", parentId: "", icon: "" },
  ].map((c, i) => ({ ...c, createdAt: ago(30 - i), updatedAt: ago(10 - i / 2) }));

  const prompts = [
    {
      id: "p-sys-writer", name: "Calm technical writer", kind: "system",
      categoryId: "cat-writing", systemPromptId: "", tags: ["style", "writing"],
      body: "You are a calm, precise technical writer.\n\n- Prefer short sentences and concrete examples.\n- Never use marketing language.\n- Use Markdown headings and lists where they aid scanning.\n- When unsure, say so explicitly.",
      variables: [], version: 3, createdAt: ago(28), updatedAt: ago(2),
    },
    {
      id: "p-sys-reviewer", name: "Strict Go reviewer", kind: "system",
      categoryId: "cat-review", systemPromptId: "", tags: ["go", "review"],
      body: "You are a strict but kind Go code reviewer.\n\nFocus on:\n1. Correctness and error handling\n2. API surface minimalism\n3. Idiomatic naming\n\nQuote the exact line you comment on. Do not restate the diff.",
      variables: [], version: 5, createdAt: ago(25), updatedAt: ago(1),
    },
    {
      id: "p-blog-outline", name: "Blog post outline", kind: "user",
      categoryId: "cat-blog", systemPromptId: "p-sys-writer", tags: ["blog", "writing"],
      body: "Draft an outline for a blog post about **{{topic}}**.\n\nAudience: {{audience}}\n\nRequirements:\n- A hook that avoids clich\u00e9s\n- 3\u20135 sections with one-line summaries\n- A closing that suggests one concrete next step",
      variables: ["topic", "audience"], version: 2, createdAt: ago(20), updatedAt: ago(3),
    },
    {
      id: "p-pr-review", name: "PR review pass", kind: "user",
      categoryId: "cat-review", systemPromptId: "p-sys-reviewer", tags: ["go", "review"],
      body: "Review the following diff.\n\n```\n{{diff}}\n```\n\nReturn findings grouped by severity (`blocker`, `nit`). If there are no blockers, say `LGTM` first.",
      variables: ["diff"], version: 4, createdAt: ago(18), updatedAt: ago(1),
    },
    {
      id: "p-cold-email", name: "Cold email opener", kind: "user",
      categoryId: "cat-email", systemPromptId: "p-sys-writer", tags: ["email", "outreach"],
      body: "Write a two-sentence cold email opener to {{name}} at {{company}}.\n\nContext: {{context}}\n\nRules:\n- No flattery\n- Reference something specific and recent",
      variables: ["name", "company", "context"], version: 1, createdAt: ago(12), updatedAt: ago(5),
    },
    {
      id: "p-paper-summary", name: "Paper summarizer", kind: "user",
      categoryId: "cat-research", systemPromptId: "", tags: ["research", "summarize"],
      body: "Summarize the paper below in three layers:\n\n1. One sentence\n2. One paragraph\n3. Section-by-section notes\n\n---\n\n{{paper_text}}",
      variables: ["paper_text"], version: 1, createdAt: ago(9), updatedAt: ago(4),
    },
    {
      id: "p-scratch", name: "Quick brainstorm", kind: "user",
      categoryId: "", systemPromptId: "", tags: ["scratch"],
      body: "Give me {{n}} unusual ideas for {{subject}}. One line each, no explanations.",
      variables: ["n", "subject"], version: 1, createdAt: ago(3), updatedAt: ago(3),
    },
  ];

  const notes = [
    {
      id: "n-writer-tips", title: "Works best with model settings", categoryId: "cat-writing",
      tags: ["tips"], promptId: "p-sys-writer",
      body: "Temperature **0.4** keeps the tone stable. Higher values drift into marketing speak.\n\nPairs well with `Blog post outline`.",
      createdAt: ago(15), updatedAt: ago(2),
    },
    {
      id: "n-review-usage", title: "Usage tips", categoryId: "cat-review",
      tags: ["tips", "go"], promptId: "p-pr-review",
      body: "- Paste the *full* diff, not a summary \u2014 the reviewer quotes lines.\n- For large diffs, split by package.\n- Model X tends to over-flag naming nits; ignore `nit` severity from it.",
      createdAt: ago(10), updatedAt: ago(1),
    },
    {
      id: "n-outline-example", title: "Good output example", categoryId: "cat-blog",
      tags: ["example"], promptId: "p-blog-outline",
      body: "The 2026-01 run on \u201clocal-first sync\u201d produced a great outline \u2014 kept in `docs/examples`. Reuse its hook style.",
      createdAt: ago(8), updatedAt: ago(8),
    },
    {
      id: "n-reading-list", title: "Reading list: prompt engineering", categoryId: "cat-research",
      tags: ["research", "reading"], promptId: "",
      body: "# To read\n\n- [ ] \u201cPrompting as programming\u201d\n- [ ] The system-prompt ablation thread\n\n> Rough notes only \u2014 promote useful ones to prompts.",
      createdAt: ago(6), updatedAt: ago(2),
    },
    {
      id: "n-scratchpad", title: "Scratchpad", categoryId: "",
      tags: ["scratch"], promptId: "",
      body: "Unsorted thoughts live here.\n\n```\ntry: kind filter in tree\n```",
      createdAt: ago(2), updatedAt: ago(0.5),
    },
  ];

  const db = { cats: [...cats], prompts: [...prompts], notes: [...notes] };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const reject = (code, message, field) => { throw new APIError(code, message, field || "", 400); };
  const find = (arr, itemID) => arr.find((x) => x.id === itemID);

  function validatePrompt(input) {
    if (!input.name || !input.name.trim()) reject("validation_failed", "name must not be empty", "name");
    if (!input.body || !input.body.trim()) reject("validation_failed", "body must not be empty", "body");
    const kind = input.kind || "user";
    if (kind !== "system" && kind !== "user") reject("validation_failed", "kind must be system or user", "kind");
    if (kind === "system" && input.systemPromptId) {
      reject("validation_failed", "a system prompt cannot reference another system prompt", "systemPromptId");
    }
    if (input.systemPromptId) {
      const ref = find(db.prompts, input.systemPromptId);
      if (!ref || ref.kind !== "system") {
        reject("validation_failed", "systemPromptId must reference an existing system prompt", "systemPromptId");
      }
    }
    if (input.categoryId && !find(db.cats, input.categoryId)) {
      reject("validation_failed", "unknown category", "categoryId");
    }
  }

  return {
    async detect() { return { categories: true }; },
    async listPrompts() { return clone(db.prompts); },
    async listNotes() { return clone(db.notes); },
    async listCategories() { return clone(db.cats); },
    async createPrompt(input) {
      validatePrompt(input);
      const p = {
        id: id(), name: input.name.trim(), kind: input.kind || "user",
        categoryId: input.categoryId || "", systemPromptId: input.systemPromptId || "",
        tags: input.tags || [], body: input.body, variables: input.variables || [],
        version: 1, createdAt: now(), updatedAt: now(),
      };
      db.prompts.push(p);
      return clone(p);
    },
    async updatePrompt(pid, input) {
      const p = find(db.prompts, pid);
      if (!p) reject("not_found", "prompt not found");
      validatePrompt(input);
      Object.assign(p, {
        name: input.name.trim(), kind: input.kind || "user",
        categoryId: input.categoryId || "", systemPromptId: input.systemPromptId || "",
        tags: input.tags || [], body: input.body, variables: input.variables || [],
        version: p.version + 1, updatedAt: now(),
      });
      return clone(p);
    },
    async deletePrompt(pid, force) {
      const p = find(db.prompts, pid);
      if (!p) reject("not_found", "prompt not found");
      const refs = db.prompts.filter((x) => x.systemPromptId === pid);
      if (refs.length && !force) {
        reject("validation_failed",
          "system prompt is referenced by " + refs.length + " user prompt(s); use force to clear references");
      }
      refs.forEach((x) => { x.systemPromptId = ""; });
      db.prompts = db.prompts.filter((x) => x.id !== pid);
      db.notes.forEach((n) => { if (n.promptId === pid) n.promptId = ""; });
    },
    async createNote(input) {
      if (!input.title || !input.title.trim()) reject("validation_failed", "title must not be empty", "title");
      const n = {
        id: id(), title: input.title.trim(), categoryId: input.categoryId || "",
        tags: input.tags || [], body: input.body || "", promptId: input.promptId || "",
        createdAt: now(), updatedAt: now(),
      };
      db.notes.push(n);
      return clone(n);
    },
    async updateNote(nid, input) {
      const n = find(db.notes, nid);
      if (!n) reject("not_found", "note not found");
      if (!input.title || !input.title.trim()) reject("validation_failed", "title must not be empty", "title");
      Object.assign(n, {
        title: input.title.trim(), categoryId: input.categoryId || "",
        tags: input.tags || [], body: input.body || "", promptId: input.promptId || "",
        updatedAt: now(),
      });
      return clone(n);
    },
    async deleteNote(nid) {
      if (!find(db.notes, nid)) reject("not_found", "note not found");
      db.notes = db.notes.filter((x) => x.id !== nid);
    },
    async createCategory(input) {
      if (!input.name || !input.name.trim()) reject("validation_failed", "name must not be empty", "name");
      if (input.parentId && !find(db.cats, input.parentId)) reject("validation_failed", "unknown parent", "parentId");
      const c = { id: id(), name: input.name.trim(), parentId: input.parentId || "", createdAt: now(), updatedAt: now() };
      db.cats.push(c);
      return clone(c);
    },
    async updateCategory(cid, input) {
      const c = find(db.cats, cid);
      if (!c) reject("not_found", "category not found");
      if (!input.name || !input.name.trim()) reject("validation_failed", "name must not be empty", "name");
      let cur = input.parentId || "";
      while (cur) {
        if (cur === cid) reject("validation_failed", "category cycle", "parentId");
        const pc = find(db.cats, cur);
        cur = pc ? pc.parentId : "";
      }
      Object.assign(c, { name: input.name.trim(), parentId: input.parentId || "", updatedAt: now() });
      return clone(c);
    },
    async deleteCategory(cid, force) {
      const c = find(db.cats, cid);
      if (!c) reject("not_found", "category not found");
      const kids = db.cats.filter((x) => x.parentId === cid);
      const used = db.prompts.some((p) => p.categoryId === cid) || db.notes.some((n) => n.categoryId === cid);
      if ((kids.length || used) && !force) {
        reject("validation_failed", "category is not empty; use force to re-parent children and unassign items");
      }
      kids.forEach((k) => { k.parentId = c.parentId; });
      db.prompts.forEach((p) => { if (p.categoryId === cid) p.categoryId = ""; });
      db.notes.forEach((n) => { if (n.categoryId === cid) n.categoryId = ""; });
      db.cats = db.cats.filter((x) => x.id !== cid);
    },
  };
}

/* =============================== state ================================= */

const state = {
  backend: null,
  mock: new URLSearchParams(location.search).has("mock"),
  hasCategories: false,
  categories: [],
  prompts: [],
  notes: [],
  search: "",
  activeTag: "",
  expanded: new Set(JSON.parse(localStorage.getItem("cue-note-expanded") || "[]")),
  loading: true,
  loadError: null,
};

const THEMES = ["light", "dark", "sepia"];

function saveExpanded() {
  localStorage.setItem("cue-note-expanded", JSON.stringify([...state.expanded]));
}

function promptById(id) { return state.prompts.find((p) => p.id === id); }
function noteById(id) { return state.notes.find((n) => n.id === id); }
function categoryById(id) { return state.categories.find((c) => c.id === id); }
function promptKind(p) { return p.kind === "system" ? "system" : "user"; }
function notesForPrompt(pid) { return state.notes.filter((n) => n.promptId === pid); }

function categoryPath(id) {
  const path = [];
  let cur = categoryById(id);
  let guard = 0;
  while (cur && guard++ < 50) {
    path.unshift(cur);
    cur = categoryById(cur.parentId);
  }
  return path;
}

function allTags() {
  const set = new Set();
  state.prompts.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
  state.notes.forEach((n) => (n.tags || []).forEach((t) => set.add(t)));
  return [...set].sort();
}

function matchesFilters(item, isPrompt) {
  if (state.activeTag && !(item.tags || []).includes(state.activeTag)) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    const hay = ((isPrompt ? item.name : item.title) + "\n" + (item.body || "") + "\n" +
      (item.tags || []).join(" ")).toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function filteredPrompts() { return state.prompts.filter((p) => matchesFilters(p, true)); }
function filteredNotes() { return state.notes.filter((n) => matchesFilters(n, false)); }

async function loadAll() {
  state.loading = true;
  state.loadError = null;
  renderAll();
  try {
    const [prompts, notes, categories] = await Promise.all([
      state.backend.listPrompts(),
      state.backend.listNotes(),
      state.hasCategories ? state.backend.listCategories() : Promise.resolve([]),
    ]);
    state.prompts = prompts;
    state.notes = notes;
    state.categories = categories;
  } catch (err) {
    state.loadError = err;
  }
  state.loading = false;
  renderAll();
}

/* =============================== toasts ================================ */

function toast(message, isError) {
  const el = h("div", { class: "toast" + (isError ? " error" : "") }, message);
  $("#toasts").append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3200);
}

function toastError(err) {
  if (err instanceof APIError) {
    toast(err.field ? err.message + " (" + err.field + ")" : err.message, true);
  } else {
    toast(String(err && err.message || err), true);
  }
}

/* =============================== router ================================ */

function route() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = hash.split("/");
  return { view: head || "home", id: rest.join("/") };
}

function nav(hash) { location.hash = hash; }

/* ================================ tree ================================= */

const KIND_ICON = { system: "\u2699\uFE0F", user: "\u{1F4AC}" };
const NOTE_ICON = "\u{1F4DD}";
const CAT_ICON = "\u{1F4C1}";

function countInCategory(catID) {
  const ids = new Set([catID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of state.categories) {
      if (ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); changed = true; }
    }
  }
  return filteredPrompts().filter((p) => ids.has(p.categoryId)).length +
    filteredNotes().filter((n) => ids.has(n.categoryId)).length;
}

function treeRow(opts) {
  const { key, label, icon, count, depth, selected, hasChildren, onclick, onadd, addTitle } = opts;
  const expanded = state.expanded.has(key);
  const chevron = h("button", {
    class: "tree-chevron" + (expanded ? " expanded" : "") + (hasChildren ? "" : " leaf"),
    title: hasChildren ? (expanded ? "Collapse" : "Expand") : "",
    onclick: (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (expanded) state.expanded.delete(key); else state.expanded.add(key);
      saveExpanded();
      renderSidebar();
    },
  }, "\u25B6");
  const row = h("div", {
    class: "tree-row" + (selected ? " selected" : ""),
    style: "padding-left:" + (4 + depth * 14) + "px",
    role: "treeitem",
    onclick,
  },
    chevron,
    h("span", { class: "tree-icon" }, icon),
    h("span", { class: "tree-label" }, label),
    count != null ? h("span", { class: "tree-count" }, count) : null,
    onadd ? h("button", {
      class: "tree-add", title: addTitle || "Add",
      onclick: (e) => { e.stopPropagation(); onadd(); },
    }, "+") : null,
  );
  return row;
}

function renderCategoryNode(cat, depth, container, current) {
  const key = "cat:" + cat.id;
  const kids = state.categories.filter((c) => c.parentId === cat.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const prompts = filteredPrompts().filter((p) => p.categoryId === cat.id);
  const notes = filteredNotes().filter((n) => n.categoryId === cat.id);
  const hasChildren = kids.length + prompts.length + notes.length > 0;
  container.append(treeRow({
    key,
    label: cat.name,
    icon: CAT_ICON,
    count: countInCategory(cat.id),
    depth,
    selected: current.view === "category" && current.id === cat.id,
    hasChildren,
    onclick: () => nav("#/category/" + cat.id),
    onadd: () => openNewInCategoryMenu(cat.id),
    addTitle: "Add inside " + cat.name,
  }));
  if (state.expanded.has(key)) {
    kids.forEach((k) => renderCategoryNode(k, depth + 1, container, current));
    prompts.sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
      container.append(treeRow({
        key: "prompt:" + p.id, label: p.name, icon: KIND_ICON[promptKind(p)], depth: depth + 1,
        selected: current.view === "prompt" && current.id === p.id,
        hasChildren: false, onclick: () => nav("#/prompt/" + p.id),
      }));
    });
    notes.sort((a, b) => a.title.localeCompare(b.title)).forEach((n) => {
      container.append(treeRow({
        key: "note:" + n.id, label: n.title, icon: NOTE_ICON, depth: depth + 1,
        selected: current.view === "note" && current.id === n.id,
        hasChildren: false, onclick: () => nav("#/note/" + n.id),
      }));
    });
  }
}

function renderSidebar() {
  const tree = $("#tree");
  tree.textContent = "";
  const current = route();

  tree.append(treeRow({
    key: "home", label: "All items", icon: "\u{1F3E0}", depth: 0,
    count: filteredPrompts().length + filteredNotes().length,
    selected: current.view === "home", hasChildren: false, onclick: () => nav("#/"),
  }));

  if (state.hasCategories) {
    tree.append(h("div", { class: "tree-section-title" }, "Categories"));
    state.categories.filter((c) => !c.parentId || !categoryById(c.parentId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => renderCategoryNode(c, 0, tree, current));

    const unPrompts = filteredPrompts().filter((p) => !p.categoryId || !categoryById(p.categoryId));
    const unNotes = filteredNotes().filter((n) => !n.categoryId || !categoryById(n.categoryId));
    const unKey = "uncategorized";
    tree.append(treeRow({
      key: unKey, label: "Uncategorized", icon: "\u{1F5C2}\uFE0F",
      count: unPrompts.length + unNotes.length, depth: 0,
      selected: current.view === "uncategorized",
      hasChildren: unPrompts.length + unNotes.length > 0,
      onclick: () => nav("#/uncategorized"),
    }));
    if (state.expanded.has(unKey)) {
      unPrompts.sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
        tree.append(treeRow({
          key: "prompt:" + p.id, label: p.name, icon: KIND_ICON[promptKind(p)], depth: 1,
          selected: current.view === "prompt" && current.id === p.id,
          hasChildren: false, onclick: () => nav("#/prompt/" + p.id),
        }));
      });
      unNotes.sort((a, b) => a.title.localeCompare(b.title)).forEach((n) => {
        tree.append(treeRow({
          key: "note:" + n.id, label: n.title, icon: NOTE_ICON, depth: 1,
          selected: current.view === "note" && current.id === n.id,
          hasChildren: false, onclick: () => nav("#/note/" + n.id),
        }));
      });
    }
  } else {
    // v1 fallback: flat tree grouped by tag.
    tree.append(h("div", { class: "tree-section-title" }, "By tag"));
    const groups = new Map();
    filteredPrompts().forEach((p) => (p.tags && p.tags.length ? p.tags : [""]).forEach((t) => {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push({ item: p, isPrompt: true });
    }));
    filteredNotes().forEach((n) => (n.tags && n.tags.length ? n.tags : [""]).forEach((t) => {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push({ item: n, isPrompt: false });
    }));
    [...groups.keys()].sort((a, b) => (a || "\uFFFF").localeCompare(b || "\uFFFF")).forEach((tag) => {
      const key = "taggroup:" + tag;
      const entries = groups.get(tag);
      tree.append(treeRow({
        key, label: tag || "untagged", icon: "\u{1F3F7}\uFE0F", count: entries.length, depth: 0,
        selected: false, hasChildren: entries.length > 0,
        onclick: () => {
          if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
          saveExpanded();
          renderSidebar();
        },
      }));
      if (state.expanded.has(key)) {
        entries.forEach(({ item, isPrompt }) => {
          tree.append(treeRow({
            key: (isPrompt ? "prompt:" : "note:") + item.id,
            label: isPrompt ? item.name : item.title,
            icon: isPrompt ? KIND_ICON[promptKind(item)] : NOTE_ICON,
            depth: 1,
            selected: (isPrompt ? current.view === "prompt" : current.view === "note") && current.id === item.id,
            hasChildren: false,
            onclick: () => nav((isPrompt ? "#/prompt/" : "#/note/") + item.id),
          }));
        });
      }
    });
  }

  const tagWrap = $("#tag-filters");
  tagWrap.textContent = "";
  const tags = allTags();
  $("#tag-section").hidden = tags.length === 0;
  tags.forEach((t) => {
    tagWrap.append(h("button", {
      class: "tag-chip" + (state.activeTag === t ? " active" : ""),
      onclick: () => {
        state.activeTag = state.activeTag === t ? "" : t;
        renderAll();
      },
    }, "#" + t));
  });

  $("#new-category-btn").hidden = !state.hasCategories;
}

function openNewInCategoryMenu(catID) {
  openModal("Add to " + (categoryById(catID) ? categoryById(catID).name : "category"), (body, close) => {
    body.append(
      h("div", { class: "modal-actions", style: "justify-content:flex-start;margin-top:4px" },
        h("button", { class: "btn", onclick: () => { close(); nav("#/new-prompt/" + catID); } }, KIND_ICON.user + " New prompt"),
        h("button", { class: "btn", onclick: () => { close(); nav("#/new-note/" + catID); } }, NOTE_ICON + " New note"),
        h("button", { class: "btn", onclick: () => { close(); openCategoryModal(null, catID); } }, CAT_ICON + " New subcategory"),
      ),
    );
  });
}

/* ============================== breadcrumb ============================= */

function renderBreadcrumb() {
  const bc = $("#breadcrumb");
  bc.textContent = "";
  const r = route();
  const crumbs = [{ label: "cue-note", hash: "#/" }];
  const pushCat = (catID) => categoryPath(catID).forEach((c) =>
    crumbs.push({ label: c.name, hash: "#/category/" + c.id }));
  if (r.view === "category" && categoryById(r.id)) {
    pushCat(r.id);
  } else if (r.view === "uncategorized") {
    crumbs.push({ label: "Uncategorized" });
  } else if (r.view === "prompt") {
    const p = promptById(r.id);
    if (p) {
      if (p.categoryId && categoryById(p.categoryId)) pushCat(p.categoryId);
      crumbs.push({ label: p.name });
    }
  } else if (r.view === "note") {
    const n = noteById(r.id);
    if (n) {
      if (n.categoryId && categoryById(n.categoryId)) pushCat(n.categoryId);
      crumbs.push({ label: n.title });
    }
  } else if (r.view === "new-prompt") {
    crumbs.push({ label: "New prompt" });
  } else if (r.view === "new-note") {
    crumbs.push({ label: "New note" });
  }
  crumbs.forEach((c, i) => {
    if (i > 0) bc.append(h("span", { class: "crumb-sep" }, "/"));
    if (c.hash && i < crumbs.length - 1) {
      bc.append(h("a", { href: c.hash }, c.label));
    } else {
      bc.append(h("span", { class: "crumb-current" }, snippet(c.label, 40)));
    }
  });
}

/* ============================ canvas: lists ============================ */

function itemRow(item, isPrompt) {
  const kind = isPrompt ? promptKind(item) : null;
  return h("div", {
    class: "item-row",
    onclick: () => nav((isPrompt ? "#/prompt/" : "#/note/") + item.id),
  },
    h("span", { class: "item-icon" }, isPrompt ? KIND_ICON[kind] : NOTE_ICON),
    h("span", { class: "item-name" }, isPrompt ? item.name : item.title),
    isPrompt ? h("span", { class: "chip kind-" + kind }, kind) : null,
    !isPrompt && item.promptId && promptById(item.promptId)
      ? h("span", { class: "chip chip-link" }, "\u{1F517} " + snippet(promptById(item.promptId).name, 24)) : null,
    h("span", { class: "item-snippet" }, snippet(item.body, 90)),
  );
}

function renderListView(canvas, opts) {
  const { icon, title, prompts, notes, emptyText, categoryID } = opts;
  canvas.append(h("div", { class: "page-icon" }, icon));
  const head = h("div", { style: "display:flex;align-items:center;gap:10px" },
    h("h1", { class: "page-title", style: "flex:1" }, title));
  if (categoryID) {
    head.append(
      h("button", { class: "btn subtle", onclick: () => openCategoryModal(categoryById(categoryID)) }, "Rename"),
      h("button", { class: "btn subtle", onclick: () => deleteCategoryFlow(categoryID) }, "Delete"),
    );
  }
  canvas.append(head);

  if (categoryID) {
    const kids = state.categories.filter((c) => c.parentId === categoryID)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (kids.length) {
      canvas.append(h("div", { class: "list-section-title" }, "Subcategories"));
      const list = h("div", { class: "item-list" });
      kids.forEach((c) => list.append(h("div", {
        class: "item-row", onclick: () => nav("#/category/" + c.id),
      },
        h("span", { class: "item-icon" }, CAT_ICON),
        h("span", { class: "item-name" }, c.name),
        h("span", { class: "item-snippet" }, countInCategory(c.id) + " item(s)"),
      )));
      canvas.append(list);
    }
  }

  const sections = [
    ["System prompts", prompts.filter((p) => promptKind(p) === "system"), true],
    ["User prompts", prompts.filter((p) => promptKind(p) === "user"), true],
    ["Notes", notes, false],
  ];
  let any = false;
  for (const [label, items, isPrompt] of sections) {
    if (!items.length) continue;
    any = true;
    canvas.append(h("div", { class: "list-section-title" }, label + " \u00B7 " + items.length));
    const list = h("div", { class: "item-list" });
    items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .forEach((item) => list.append(itemRow(item, isPrompt)));
    canvas.append(list);
  }
  if (!any) {
    canvas.append(h("div", { class: "empty-state" },
      h("div", { class: "empty-icon" }, "\u{1FAB6}"),
      h("h3", null, "Nothing here yet"),
      h("p", null, emptyText || "Create a prompt or a note to get started."),
      h("div", null,
        h("button", { class: "btn primary", onclick: () => nav("#/new-prompt/" + (categoryID || "")) }, "New prompt"),
        " ",
        h("button", { class: "btn", onclick: () => nav("#/new-note/" + (categoryID || "")) }, "New note"),
      ),
    ));
  }
}

/* ======================== canvas: editor helpers ======================= */

function editorBlock(getBody, setBody, storageKey) {
  let mode = localStorage.getItem("cue-note-editor-mode") || "split";
  const wrap = h("div");
  const textarea = h("textarea", {
    class: "body-editor",
    placeholder: "Write Markdown\u2026  Use {{variable}} tokens in prompt bodies.",
    oninput: () => { setBody(textarea.value); preview.innerHTML = renderMarkdown(textarea.value); },
  });
  textarea.value = getBody();
  const preview = h("div", { class: "md-preview" });
  preview.innerHTML = renderMarkdown(getBody());

  const tabs = h("div", { class: "editor-tabs" });
  const content = h("div");
  const setMode = (m) => {
    mode = m;
    localStorage.setItem("cue-note-editor-mode", m);
    tabs.querySelectorAll(".editor-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    content.textContent = "";
    if (m === "write") content.append(textarea);
    else if (m === "preview") { preview.innerHTML = renderMarkdown(getBody()); content.append(preview); }
    else {
      const split = h("div", { class: "editor-split" });
      split.append(textarea, preview);
      preview.innerHTML = renderMarkdown(getBody());
      content.append(split);
    }
  };
  [["write", "Write"], ["split", "Split"], ["preview", "Preview"]].forEach(([m, label]) => {
    tabs.append(h("button", { class: "editor-tab", dataset: { mode: m }, onclick: () => setMode(m) }, label));
  });
  wrap.append(tabs, content);
  setMode(mode);
  return wrap;
}

function categorySelect(value, onchange) {
  const sel = h("select", { onchange: (e) => onchange(e.target.value) });
  sel.append(h("option", { value: "" }, "Uncategorized"));
  const addOptions = (parentId, depth) => {
    state.categories.filter((c) => c.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        sel.append(h("option", { value: c.id }, "\u00A0".repeat(depth * 3) + c.name));
        addOptions(c.id, depth + 1);
      });
  };
  addOptions("", 0);
  sel.value = categoryById(value) ? value : "";
  return sel;
}

/* ======================== canvas: prompt detail ======================== */

function renderPromptDetail(canvas, existing, initialCategory, draftOverride) {
  const isNew = !existing;
  const draft = draftOverride || (existing
    ? {
      name: existing.name, kind: promptKind(existing), categoryId: existing.categoryId || "",
      systemPromptId: existing.systemPromptId || "", tags: [...(existing.tags || [])],
      body: existing.body, variables: [...(existing.variables || [])],
    }
    : { name: "", kind: "user", categoryId: initialCategory || "", systemPromptId: "", tags: [], body: "", variables: [] });

  const kind = draft.kind;
  canvas.append(h("div", { class: "page-icon" }, KIND_ICON[kind]));
  const titleInput = h("input", {
    class: "page-title", type: "text", placeholder: "Untitled prompt",
    value: draft.name, oninput: () => { draft.name = titleInput.value; },
  });
  canvas.append(titleInput);

  const props = h("div", { class: "props" });

  // kind
  const kindSel = h("select", {
    onchange: () => {
      draft.kind = kindSel.value;
      if (draft.kind === "system") draft.systemPromptId = "";
      rerenderDetail();
    },
  }, h("option", { value: "user" }, "user"), h("option", { value: "system" }, "system"));
  kindSel.value = kind;
  props.append(h("div", { class: "prop-row" },
    h("div", { class: "prop-label" }, "\u2699\uFE0F Kind"),
    h("div", { class: "prop-value" },
      h("span", { class: "chip kind-" + kind }, kind + " prompt"), kindSel),
  ));

  // category
  if (state.hasCategories) {
    props.append(h("div", { class: "prop-row" },
      h("div", { class: "prop-label" }, CAT_ICON + " Category"),
      h("div", { class: "prop-value" },
        categorySelect(draft.categoryId, (v) => { draft.categoryId = v; })),
    ));
  }

  // linked system prompt (user prompts only)
  if (kind === "user") {
    const sysSel = h("select", {
      onchange: () => { draft.systemPromptId = sysSel.value; rerenderDetail(); },
    }, h("option", { value: "" }, "\u2014 none \u2014"));
    state.prompts.filter((p) => promptKind(p) === "system" && (!existing || p.id !== existing.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((p) => sysSel.append(h("option", { value: p.id }, p.name)));
    sysSel.value = promptById(draft.systemPromptId) ? draft.systemPromptId : "";

    const valueWrap = h("div", { class: "prop-value" });
    const linked = promptById(draft.systemPromptId);
    if (linked) {
      valueWrap.append(
        h("a", { class: "chip chip-link", href: "#/prompt/" + linked.id },
          KIND_ICON.system + " " + linked.name),
        sysSel,
      );
    } else {
      valueWrap.append(sysSel);
    }
    props.append(h("div", { class: "prop-row" },
      h("div", { class: "prop-label" }, "\u{1F517} System prompt"), valueWrap));
    if (linked) {
      const pv = h("div", { class: "sys-preview" },
        h("div", { class: "sys-preview-head" }, KIND_ICON.system + " " + linked.name,
          h("a", { href: "#/prompt/" + linked.id, style: "margin-left:auto;font-weight:400" }, "open \u2192")),
        h("div", { class: "sys-preview-body" }, snippet(linked.body, 420)),
      );
      props.append(h("div", { class: "prop-row" },
        h("div", { class: "prop-label" }), h("div", { class: "prop-value" }, pv)));
    }
  }

  // tags
  const tagsInput = h("input", {
    type: "text", value: draft.tags.join(", "), placeholder: "comma, separated, tags",
    oninput: () => { draft.tags = parseTags(tagsInput.value); },
  });
  props.append(h("div", { class: "prop-row" },
    h("div", { class: "prop-label" }, "\u{1F3F7}\uFE0F Tags"),
    h("div", { class: "prop-value" },
      draft.tags.map((t) => h("span", { class: "chip" }, "#" + t)), tagsInput),
  ));

  // variables
  const varsInput = h("input", {
    type: "text", value: draft.variables.join(", "), placeholder: "topic, audience",
    oninput: () => {
      draft.variables = [...new Set(varsInput.value.split(",").map((v) => v.trim()).filter(Boolean))];
    },
  });
  props.append(h("div", { class: "prop-row" },
    h("div", { class: "prop-label" }, "\u{1F9E9} Variables"),
    h("div", { class: "prop-value" },
      draft.variables.map((v) => h("span", { class: "var-token" }, "{{" + v + "}}")), varsInput),
  ));

  canvas.append(props);

  canvas.append(editorBlock(() => draft.body, (v) => { draft.body = v; }));

  const bar = h("div", { class: "action-bar" });
  bar.append(h("button", {
    class: "btn primary",
    onclick: async () => {
      try {
        const input = {
          name: draft.name, kind: draft.kind, categoryId: draft.categoryId,
          systemPromptId: draft.kind === "user" ? draft.systemPromptId : "",
          tags: draft.tags, body: draft.body, variables: draft.variables,
        };
        if (!state.hasCategories) { delete input.kind; delete input.categoryId; delete input.systemPromptId; }
        const saved = isNew
          ? await state.backend.createPrompt(input)
          : await state.backend.updatePrompt(existing.id, input);
        toast(isNew ? "Prompt created" : "Prompt saved");
        await loadAll();
        nav("#/prompt/" + saved.id);
        if (!isNew) renderAll();
      } catch (err) { toastError(err); }
    },
  }, isNew ? "Create prompt" : "Save"));
  if (!isNew) {
    bar.append(h("button", {
      class: "btn danger",
      onclick: () => deletePromptFlow(existing),
    }, "Delete"));
    bar.append(h("span", { class: "meta-line" },
      "v" + existing.version + " \u00B7 updated " + fmtDate(existing.updatedAt)));
  }
  canvas.append(bar);

  if (!isNew) renderAttachedNotes(canvas, existing);

  function rerenderDetail() {
    canvas.textContent = "";
    renderPromptDetail(canvas, existing, initialCategory, draft);
  }
}

function renderAttachedNotes(canvas, prompt) {
  const wrap = h("div", { class: "attached-notes" });
  const notes = notesForPrompt(prompt.id)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  wrap.append(h("div", { class: "attached-notes-head" },
    h("h3", null, NOTE_ICON + " Attached notes"),
    h("span", { class: "tree-count" }, notes.length),
    h("button", {
      class: "btn subtle", style: "margin-left:auto",
      onclick: () => openAttachedNoteModal(prompt, null),
    }, "+ Add note"),
  ));
  if (!notes.length) {
    wrap.append(h("div", { class: "callout" },
      h("span", { class: "callout-icon" }, "\u{1F4A1}"),
      h("div", { class: "callout-body" },
        h("div", { class: "callout-text" },
          "No notes yet. Attach usage tips, model settings, or good output examples to this prompt.")),
    ));
  }
  notes.forEach((n) => {
    const callout = h("div", { class: "callout" },
      h("span", { class: "callout-icon" }, "\u{1F4CC}"),
      h("div", { class: "callout-body" },
        h("div", { class: "callout-title", onclick: () => nav("#/note/" + n.id) }, n.title),
        (() => { const d = h("div", { class: "callout-text" }); d.innerHTML = renderMarkdown(n.body); return d; })(),
      ),
      h("div", { class: "callout-actions" },
        h("button", { onclick: () => openAttachedNoteModal(prompt, n) }, "Edit"),
        h("button", {
          onclick: async () => {
            try {
              await state.backend.updateNote(n.id, {
                title: n.title, tags: n.tags || [], body: n.body,
                categoryId: n.categoryId || "", promptId: "",
              });
              toast("Note detached");
              await loadAll();
            } catch (err) { toastError(err); }
          },
        }, "Detach"),
        h("button", {
          onclick: () => confirmModal("Delete note", "Delete \u201C" + n.title + "\u201D permanently?", async () => {
            try {
              await state.backend.deleteNote(n.id);
              toast("Note deleted");
              await loadAll();
            } catch (err) { toastError(err); }
          }),
        }, "Delete"),
      ),
    );
    wrap.append(callout);
  });
  canvas.append(wrap);
}

function deletePromptFlow(prompt) {
  confirmModal("Delete prompt", "Delete \u201C" + prompt.name + "\u201D permanently?", async () => {
    try {
      await state.backend.deletePrompt(prompt.id, false);
      toast("Prompt deleted");
      await loadAll();
      nav("#/");
    } catch (err) {
      if (err instanceof APIError && err.code === "validation_failed") {
        confirmModal("Prompt is referenced", err.message + " Delete anyway and clear references?", async () => {
          try {
            await state.backend.deletePrompt(prompt.id, true);
            toast("Prompt deleted");
            await loadAll();
            nav("#/");
          } catch (e2) { toastError(e2); }
        });
      } else {
        toastError(err);
      }
    }
  });
}

/* ========================= canvas: note detail ========================= */

function renderNoteDetail(canvas, existing, initialCategory) {
  const isNew = !existing;
  const draft = existing
    ? {
      title: existing.title, categoryId: existing.categoryId || "",
      tags: [...(existing.tags || [])], body: existing.body, promptId: existing.promptId || "",
    }
    : { title: "", categoryId: initialCategory || "", tags: [], body: "", promptId: "" };

  canvas.append(h("div", { class: "page-icon" }, NOTE_ICON));
  const titleInput = h("input", {
    class: "page-title", type: "text", placeholder: "Untitled note",
    value: draft.title, oninput: () => { draft.title = titleInput.value; },
  });
  canvas.append(titleInput);

  const props = h("div", { class: "props" });

  if (state.hasCategories) {
    props.append(h("div", { class: "prop-row" },
      h("div", { class: "prop-label" }, CAT_ICON + " Category"),
      h("div", { class: "prop-value" },
        categorySelect(draft.categoryId, (v) => { draft.categoryId = v; })),
    ));
  }

  // attached prompt
  const promptSel = h("select", { onchange: () => { draft.promptId = promptSel.value; } },
    h("option", { value: "" }, "\u2014 standalone note \u2014"));
  state.prompts.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
    promptSel.append(h("option", { value: p.id }, KIND_ICON[promptKind(p)] + " " + p.name));
  });
  promptSel.value = promptById(draft.promptId) ? draft.promptId : "";
  const attachedValue = h("div", { class: "prop-value" });
  const linked = promptById(draft.promptId);
  if (linked) {
    attachedValue.append(h("a", { class: "chip chip-link", href: "#/prompt/" + linked.id },
      "\u{1F517} " + linked.name));
  }
  attachedValue.append(promptSel);
  props.append(h("div", { class: "prop-row" },
    h("div", { class: "prop-label" }, "\u{1F517} Attached to"), attachedValue));

  const tagsInput = h("input", {
    type: "text", value: draft.tags.join(", "), placeholder: "comma, separated, tags",
    oninput: () => { draft.tags = parseTags(tagsInput.value); },
  });
  props.append(h("div", { class: "prop-row" },
    h("div", { class: "prop-label" }, "\u{1F3F7}\uFE0F Tags"),
    h("div", { class: "prop-value" },
      draft.tags.map((t) => h("span", { class: "chip" }, "#" + t)), tagsInput),
  ));

  canvas.append(props);
  canvas.append(editorBlock(() => draft.body, (v) => { draft.body = v; }));

  const bar = h("div", { class: "action-bar" });
  bar.append(h("button", {
    class: "btn primary",
    onclick: async () => {
      try {
        const input = {
          title: draft.title, tags: draft.tags, body: draft.body,
          promptId: draft.promptId, categoryId: draft.categoryId,
        };
        if (!state.hasCategories) delete input.categoryId;
        const saved = isNew
          ? await state.backend.createNote(input)
          : await state.backend.updateNote(existing.id, input);
        toast(isNew ? "Note created" : "Note saved");
        await loadAll();
        nav("#/note/" + saved.id);
        if (!isNew) renderAll();
      } catch (err) { toastError(err); }
    },
  }, isNew ? "Create note" : "Save"));
  if (!isNew) {
    bar.append(h("button", {
      class: "btn danger",
      onclick: () => confirmModal("Delete note", "Delete \u201C" + existing.title + "\u201D permanently?", async () => {
        try {
          await state.backend.deleteNote(existing.id);
          toast("Note deleted");
          await loadAll();
          nav("#/");
        } catch (err) { toastError(err); }
      }),
    }, "Delete"));
    bar.append(h("span", { class: "meta-line" }, "updated " + fmtDate(existing.updatedAt)));
  }
  canvas.append(bar);
}

/* =============================== modals ================================ */

function openModal(title, build) {
  const overlay = $("#modal-overlay");
  const modal = $("#modal");
  modal.textContent = "";
  modal.append(h("h3", null, title));
  const close = () => { overlay.hidden = true; };
  build(modal, close);
  overlay.hidden = false;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);
  const first = modal.querySelector("input, select, textarea, button");
  if (first) first.focus();
}

function confirmModal(title, message, onConfirm) {
  openModal(title, (body, close) => {
    body.append(
      h("p", { class: "modal-note" }, message),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onclick: close }, "Cancel"),
        h("button", { class: "btn danger", onclick: async () => { close(); await onConfirm(); } }, "Confirm"),
      ),
    );
  });
}

function openCategoryModal(existing, parentId) {
  openModal(existing ? "Rename category" : "New category", (body, close) => {
    const nameInput = h("input", { type: "text", value: existing ? existing.name : "" });
    const parentSel = categorySelect(existing ? existing.parentId : (parentId || ""), () => {});
    parentSel.querySelector("option").textContent = "\u2014 top level \u2014";
    body.append(
      h("div", { class: "field" }, h("label", null, "Name"), nameInput),
      h("div", { class: "field" }, h("label", null, "Parent category"), parentSel),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onclick: close }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              const input = { name: nameInput.value, parentId: parentSel.value };
              if (existing) await state.backend.updateCategory(existing.id, input);
              else await state.backend.createCategory(input);
              toast(existing ? "Category saved" : "Category created");
              close();
              await loadAll();
            } catch (err) { toastError(err); }
          },
        }, existing ? "Save" : "Create"),
      ),
    );
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") body.querySelector(".btn.primary").click();
    });
  });
}

function deleteCategoryFlow(catID) {
  const cat = categoryById(catID);
  if (!cat) return;
  confirmModal("Delete category", "Delete \u201C" + cat.name + "\u201D?", async () => {
    try {
      await state.backend.deleteCategory(catID, false);
      toast("Category deleted");
      await loadAll();
      nav("#/");
    } catch (err) {
      if (err instanceof APIError && err.code === "validation_failed") {
        confirmModal("Category is not empty",
          err.message + " Delete anyway? Children move up a level and items become uncategorized.",
          async () => {
            try {
              await state.backend.deleteCategory(catID, true);
              toast("Category deleted");
              await loadAll();
              nav("#/");
            } catch (e2) { toastError(e2); }
          });
      } else {
        toastError(err);
      }
    }
  });
}

function openAttachedNoteModal(prompt, existing) {
  openModal(existing ? "Edit note" : "Add note to \u201C" + prompt.name + "\u201D", (body, close) => {
    const titleInput = h("input", { type: "text", value: existing ? existing.title : "", placeholder: "e.g. Works best with model X" });
    const tagsInput = h("input", { type: "text", value: existing ? (existing.tags || []).join(", ") : "", placeholder: "tips, models" });
    const bodyInput = h("textarea", { rows: 6, placeholder: "Markdown\u2026" });
    bodyInput.value = existing ? existing.body : "";
    body.append(
      h("div", { class: "field" }, h("label", null, "Title"), titleInput),
      h("div", { class: "field" }, h("label", null, "Tags"), tagsInput),
      h("div", { class: "field" }, h("label", null, "Body"), bodyInput),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onclick: close }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            try {
              const input = {
                title: titleInput.value, tags: parseTags(tagsInput.value),
                body: bodyInput.value, promptId: prompt.id,
                categoryId: existing ? (existing.categoryId || "") : (prompt.categoryId || ""),
              };
              if (!state.hasCategories) delete input.categoryId;
              if (existing) await state.backend.updateNote(existing.id, input);
              else await state.backend.createNote(input);
              toast(existing ? "Note saved" : "Note attached");
              close();
              await loadAll();
            } catch (err) { toastError(err); }
          },
        }, existing ? "Save" : "Attach"),
      ),
    );
  });
}

/* =========================== command palette =========================== */

const palette = {
  open: false,
  items: [],
  active: 0,
};

function paletteCommands() {
  const cmds = [
    { icon: "\u{1F4AC}", label: "New prompt", hint: "create", run: () => nav("#/new-prompt/") },
    { icon: NOTE_ICON, label: "New note", hint: "create", run: () => nav("#/new-note/") },
  ];
  if (state.hasCategories) {
    cmds.push({ icon: CAT_ICON, label: "New category", hint: "create", run: () => openCategoryModal(null, "") });
  }
  THEMES.forEach((t) => cmds.push({
    icon: "\u{1F3A8}", label: "Theme: " + t, hint: "theme", run: () => setTheme(t),
  }));
  cmds.push({ icon: "\u{1F3E0}", label: "Go home", hint: "nav", run: () => nav("#/") });
  state.prompts.forEach((p) => cmds.push({
    icon: KIND_ICON[promptKind(p)], label: p.name, hint: "prompt", run: () => nav("#/prompt/" + p.id),
  }));
  state.notes.forEach((n) => cmds.push({
    icon: NOTE_ICON, label: n.title, hint: "note", run: () => nav("#/note/" + n.id),
  }));
  state.categories.forEach((c) => cmds.push({
    icon: CAT_ICON, label: c.name, hint: "category", run: () => nav("#/category/" + c.id),
  }));
  return cmds;
}

function openPalette() {
  palette.open = true;
  $("#palette-overlay").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  renderPaletteResults("");
  input.focus();
}

function closePalette() {
  palette.open = false;
  $("#palette-overlay").hidden = true;
}

function renderPaletteResults(query) {
  const q = query.trim().toLowerCase();
  palette.items = paletteCommands()
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint.includes(q))
    .slice(0, 12);
  palette.active = 0;
  const ul = $("#palette-results");
  ul.textContent = "";
  if (!palette.items.length) {
    ul.append(h("li", null, h("span", { style: "color:var(--fg-faint)" }, "No results")));
    return;
  }
  palette.items.forEach((c, i) => {
    ul.append(h("li", {
      class: i === palette.active ? "active" : "",
      onclick: () => { closePalette(); c.run(); },
      onmousemove: () => {
        palette.active = i;
        ul.querySelectorAll("li").forEach((li, j) => li.classList.toggle("active", j === i));
      },
    },
      h("span", null, c.icon),
      h("span", null, c.label),
      h("span", { class: "pr-hint" }, c.hint),
    ));
  });
}

/* =============================== themes ================================ */

function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cue-note-theme", t);
  toast("Theme: " + t);
}

function cycleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  setTheme(next);
}

/* ============================== rendering ============================== */

function renderCanvas() {
  const canvas = $("#canvas");
  canvas.textContent = "";
  if (state.loading) {
    canvas.append(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Loading workspace\u2026"));
    return;
  }
  if (state.loadError) {
    canvas.append(h("div", { class: "empty-state" },
      h("div", { class: "empty-icon" }, "\u26A0\uFE0F"),
      h("h3", null, "Could not load the workspace"),
      h("p", null, String(state.loadError.message || state.loadError)),
      h("button", { class: "btn primary", onclick: () => loadAll() }, "Retry"),
    ));
    return;
  }
  const r = route();
  if (r.view === "prompt") {
    const p = promptById(r.id);
    if (p) renderPromptDetail(canvas, p);
    else renderMissing(canvas, "Prompt not found");
  } else if (r.view === "note") {
    const n = noteById(r.id);
    if (n) renderNoteDetail(canvas, n);
    else renderMissing(canvas, "Note not found");
  } else if (r.view === "new-prompt") {
    renderPromptDetail(canvas, null, r.id || "");
  } else if (r.view === "new-note") {
    renderNoteDetail(canvas, null, r.id || "");
  } else if (r.view === "category") {
    const c = categoryById(r.id);
    if (!c) { renderMissing(canvas, "Category not found"); return; }
    renderListView(canvas, {
      icon: CAT_ICON, title: c.name, categoryID: c.id,
      prompts: filteredPrompts().filter((p) => p.categoryId === c.id),
      notes: filteredNotes().filter((n) => n.categoryId === c.id),
      emptyText: "This category is empty.",
    });
  } else if (r.view === "uncategorized") {
    renderListView(canvas, {
      icon: "\u{1F5C2}\uFE0F", title: "Uncategorized",
      prompts: filteredPrompts().filter((p) => !p.categoryId || !categoryById(p.categoryId)),
      notes: filteredNotes().filter((n) => !n.categoryId || !categoryById(n.categoryId)),
      emptyText: "Everything is neatly filed away.",
    });
  } else {
    const suffix = state.search || state.activeTag
      ? " \u00B7 filtered" : "";
    renderListView(canvas, {
      icon: "\u{1F4D6}", title: "All items" + suffix,
      prompts: filteredPrompts(), notes: filteredNotes(),
      emptyText: state.search || state.activeTag
        ? "Nothing matches the current filters."
        : "Create your first prompt or note to get started.",
    });
  }
}

function renderMissing(canvas, text) {
  canvas.append(h("div", { class: "empty-state" },
    h("div", { class: "empty-icon" }, "\u{1F50D}"),
    h("h3", null, text),
    h("p", null, "It may have been deleted."),
    h("button", { class: "btn", onclick: () => nav("#/") }, "Back home"),
  ));
}

function renderAll() {
  renderSidebar();
  renderBreadcrumb();
  renderCanvas();
}

/* ================================ init ================================= */

async function init() {
  $("#theme-toggle").addEventListener("click", cycleTheme);
  $("#sidebar-toggle").addEventListener("click", () => {
    $("#app").classList.toggle("sidebar-collapsed");
  });
  $("#palette-btn").addEventListener("click", openPalette);
  $("#new-prompt-btn").addEventListener("click", () => nav("#/new-prompt/"));
  $("#new-note-btn").addEventListener("click", () => nav("#/new-note/"));
  $("#new-category-btn").addEventListener("click", () => openCategoryModal(null, ""));

  const searchInput = $("#search-input");
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value.trim();
      renderAll();
    }, 120);
  });

  document.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (palette.open) closePalette(); else openPalette();
      return;
    }
    if (palette.open) {
      if (e.key === "Escape") { closePalette(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        palette.active = (palette.active + d + palette.items.length) % Math.max(palette.items.length, 1);
        $("#palette-results").querySelectorAll("li").forEach((li, j) =>
          li.classList.toggle("active", j === palette.active));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = palette.items[palette.active];
        if (item) { closePalette(); item.run(); }
      }
      return;
    }
    if (e.key === "/" && !inField) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      state.search = "";
      renderAll();
      searchInput.blur();
    }
  });

  $("#palette-input").addEventListener("input", (e) => renderPaletteResults(e.target.value));
  $("#palette-overlay").addEventListener("click", (e) => {
    if (e.target === $("#palette-overlay")) closePalette();
  });

  window.addEventListener("hashchange", renderAll);

  // Backend selection + feature detection.
  const badge = $("#mode-badge");
  if (state.mock) {
    state.backend = makeMockBackend();
    state.hasCategories = true;
    badge.textContent = "mock data";
    badge.hidden = false;
  } else {
    state.backend = RealBackend;
    try {
      const feats = await RealBackend.detect();
      state.hasCategories = feats.categories;
      if (!feats.categories) {
        badge.textContent = "v1 compatibility";
        badge.hidden = false;
      }
    } catch (err) {
      state.hasCategories = false;
      state.loading = false;
      state.loadError = err;
      renderAll();
      return;
    }
  }

  // Default expansion: open all root categories on first visit.
  if (!localStorage.getItem("cue-note-expanded")) {
    state.expanded.add("uncategorized");
  }

  await loadAll();
  if (!localStorage.getItem("cue-note-expanded-init") && state.categories.length) {
    state.categories.forEach((c) => state.expanded.add("cat:" + c.id));
    localStorage.setItem("cue-note-expanded-init", "1");
    saveExpanded();
    renderAll();
  }
}

init();
