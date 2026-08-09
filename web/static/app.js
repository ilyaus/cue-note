// cue-note UI — Linear-inspired prototype. Vanilla JS, no dependencies.
// Talks to same-origin /api/v1 (webui proxy injects the API key).
// Degrades gracefully to the v1 API (no categories/kind) and supports a
// ?mock=1 mode with in-memory sample data for demoing the full v2 UX.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ================= Utilities ================= */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const csvToList = (value) =>
    String(value || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

  // Minimal Markdown renderer (headings, bold/italic, code, fences, lists,
  // links, blockquotes). Escapes HTML first; output is safe to inject.
  function renderMarkdown(src) {
    const lines = String(src || "").split("\n");
    let html = "";
    let inCode = false;
    let listType = null;
    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    for (const raw of lines) {
      if (raw.trim().startsWith("```")) {
        closeList();
        html += inCode ? "</code></pre>" : "<pre><code>";
        inCode = !inCode;
        continue;
      }
      if (inCode) { html += esc(raw) + "\n"; continue; }
      const h = raw.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      const ul = raw.match(/^\s*[-*]\s+(.*)$/);
      const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const want = ul ? "ul" : "ol";
        if (listType !== want) { closeList(); html += `<${want}>`; listType = want; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
        continue;
      }
      closeList();
      if (raw.match(/^\s*>\s?/)) { html += `<blockquote><p>${inline(raw.replace(/^\s*>\s?/, ""))}</p></blockquote>`; continue; }
      if (raw.trim() === "") continue;
      html += `<p>${inline(raw)}</p>`;
    }
    if (inCode) html += "</code></pre>";
    closeList();
    return html;
  }

  const highlightVars = (body) =>
    esc(body).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '<span class="var-token">{{$1}}</span>');

  /* ================= Toasts ================= */

  function toast(message, type = "info") {
    const box = document.createElement("div");
    box.className = `toast ${type}`;
    box.textContent = message;
    $("toasts").append(box);
    setTimeout(() => {
      box.classList.add("leaving");
      setTimeout(() => box.remove(), 250);
    }, 3500);
  }

  /* ================= API layer ================= */

  const MOCK = new URLSearchParams(location.search).get("mock") === "1";

  async function api(path, options = {}) {
    if (MOCK) return mockApi(path, options);
    // The webui proxy maps /api/<path> -> <api>/v1/<path> and injects the key.
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const err = (payload && payload.error) || {};
      const e = new Error(err.message || `Request failed (${response.status})`);
      e.code = err.code || String(response.status);
      e.field = err.field;
      e.status = response.status;
      throw e;
    }
    return payload;
  }

  /* ---- Mock backend (?mock=1): full v2 surface, in-memory ---- */

  const mockDb = { categories: [], prompts: [], notes: [], seq: 0 };
  const mid = () => (++mockDb.seq).toString(16).padStart(8, "0");
  const now = () => new Date().toISOString();

  function seedMock() {
    const cat = (name, parentId = "") => {
      const c = { id: mid(), name, parentId, createdAt: now(), updatedAt: now() };
      mockDb.categories.push(c);
      return c;
    };
    const prompt = (p) => {
      const rec = { id: mid(), kind: "user", categoryId: "", systemPromptId: "", tags: [], variables: [], version: 1, createdAt: now(), updatedAt: now(), ...p };
      mockDb.prompts.push(rec);
      return rec;
    };
    const note = (n) => {
      const rec = { id: mid(), categoryId: "", promptId: "", tags: [], createdAt: now(), updatedAt: now(), ...n };
      mockDb.notes.push(rec);
      return rec;
    };
    const writing = cat("Writing");
    const engineering = cat("Engineering");
    const review = cat("Code Review", engineering.id);
    const debugging = cat("Debugging", engineering.id);
    const research = cat("Research");

    const sysWriter = prompt({
      name: "Senior technical writer",
      kind: "system",
      categoryId: writing.id,
      tags: ["writing", "docs"],
      body: "You are a senior technical writer. You produce clear, concise documentation aimed at software engineers.\n\nStyle rules:\n- Prefer short sentences and active voice.\n- Use concrete examples over abstract description.\n- Never pad with filler phrases.",
    });
    const sysReviewer = prompt({
      name: "Strict Go reviewer",
      kind: "system",
      categoryId: review.id,
      tags: ["go", "review"],
      body: "You are a strict but fair Go code reviewer. Focus on correctness, error handling, and API design. Flag any deviation from stdlib idioms. Cite the relevant Go proverb when applicable.",
    });
    prompt({
      name: "Write release notes",
      kind: "user",
      categoryId: writing.id,
      systemPromptId: sysWriter.id,
      tags: ["writing", "release"],
      variables: ["version", "changes"],
      body: "Write release notes for version {{version}}.\n\nRaw changes:\n{{changes}}\n\nGroup by: Features, Fixes, Breaking changes. Keep each bullet under 20 words.",
    });
    const reviewPrompt = prompt({
      name: "Review a Go diff",
      kind: "user",
      categoryId: review.id,
      systemPromptId: sysReviewer.id,
      tags: ["go", "review"],
      variables: ["diff"],
      body: "Review the following Go diff. Point out bugs first, then style.\n\n```diff\n{{diff}}\n```",
    });
    prompt({
      name: "Explain a stack trace",
      kind: "user",
      categoryId: debugging.id,
      tags: ["debugging"],
      variables: ["trace"],
      body: "Explain the most likely root cause of this stack trace and suggest the top 3 fixes:\n\n{{trace}}",
    });
    prompt({
      name: "Summarize paper",
      kind: "user",
      categoryId: research.id,
      tags: ["research", "summary"],
      variables: ["paper"],
      body: "Summarize the key contributions, methodology, and limitations of:\n\n{{paper}}",
    });
    prompt({
      name: "Quick brainstorm",
      kind: "user",
      tags: ["ideas"],
      body: "Give me 10 unconventional ideas about the topic below. Rank them by feasibility.\n\nTopic:",
    });
    note({
      title: "Works best with model X",
      promptId: reviewPrompt.id,
      categoryId: review.id,
      tags: ["models"],
      body: "Tested across models:\n\n- **model-x-large**: best balance of depth vs. noise\n- model-y: too pedantic, flags style nits as bugs\n\nUse temperature `0.2` for consistent output.",
    });
    note({
      title: "Keep diffs under 400 lines",
      promptId: reviewPrompt.id,
      categoryId: review.id,
      tags: ["usage"],
      body: "Quality drops sharply on diffs over ~400 lines. Split large PRs before review.",
    });
    note({
      title: "Prompt-writing checklist",
      categoryId: writing.id,
      tags: ["writing", "meta"],
      body: "1. State the role\n2. Give the output format explicitly\n3. Add 1-2 examples\n4. Constrain length\n\n> A prompt without an output format is a coin flip.",
    });
    note({
      title: "Ideas inbox",
      tags: ["ideas"],
      body: "Random captures:\n\n- prompt version diffing\n- shareable prompt links\n- eval harness integration",
    });
  }

  function mockList(items, params) {
    let out = items.slice();
    const q = (params.get("q") || "").toLowerCase();
    const tags = params.getAll("tag").map((t) => t.toLowerCase());
    const cat = params.get("category");
    const kind = params.get("kind");
    const promptId = params.get("prompt");
    if (q) out = out.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    if (tags.length) out = out.filter((r) => tags.every((t) => (r.tags || []).includes(t)));
    if (cat !== null) out = out.filter((r) => (r.categoryId || "") === cat);
    if (kind) out = out.filter((r) => (r.kind || "user") === kind);
    if (promptId !== null && promptId !== "") out = out.filter((r) => (r.promptId || "") === promptId);
    return { items: out, total: out.length, limit: 100, offset: 0 };
  }

  function mockErr(status, code, message, field) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    e.field = field;
    return e;
  }

  async function mockApi(path, options = {}) {
    await new Promise((r) => setTimeout(r, 120)); // simulate latency
    const [rawPath, rawQuery] = path.split("?");
    const params = new URLSearchParams(rawQuery || "");
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const seg = rawPath.split("/").filter(Boolean); // e.g. ["prompts","abc","notes"]
    const coll = seg[0];
    const id = seg[1];
    const sub = seg[2];

    const touch = (r) => { r.updatedAt = now(); return r; };

    if (coll === "categories") {
      if (!id) {
        if (method === "GET") return { items: mockDb.categories.slice(), total: mockDb.categories.length };
        if (method === "POST") {
          const name = (body?.name || "").trim();
          if (!name) throw mockErr(422, "validation_failed", "name is required", "name");
          const c = { id: mid(), name, parentId: body?.parentId || "", createdAt: now(), updatedAt: now() };
          mockDb.categories.push(c);
          return c;
        }
      } else {
        const idx = mockDb.categories.findIndex((c) => c.id === id);
        if (idx < 0) throw mockErr(404, "not_found", "category not found");
        const c = mockDb.categories[idx];
        if (method === "GET") return c;
        if (method === "PUT") {
          if (body?.name !== undefined) {
            const name = String(body.name).trim();
            if (!name) throw mockErr(422, "validation_failed", "name is required", "name");
            c.name = name;
          }
          if (body?.parentId !== undefined) c.parentId = body.parentId;
          return touch(c);
        }
        if (method === "DELETE") {
          const hasChildren = mockDb.categories.some((x) => x.parentId === id);
          const hasItems = mockDb.prompts.some((p) => p.categoryId === id) || mockDb.notes.some((n) => n.categoryId === id);
          if ((hasChildren || hasItems) && params.get("force") !== "true") {
            throw mockErr(422, "validation_failed", "category is not empty; pass force=true to delete anyway");
          }
          mockDb.categories.forEach((x) => { if (x.parentId === id) x.parentId = c.parentId; });
          mockDb.prompts.forEach((p) => { if (p.categoryId === id) p.categoryId = ""; });
          mockDb.notes.forEach((n) => { if (n.categoryId === id) n.categoryId = ""; });
          mockDb.categories.splice(idx, 1);
          return null;
        }
      }
    }

    if (coll === "prompts") {
      if (!id) {
        if (method === "GET") return mockList(mockDb.prompts, params);
        if (method === "POST") {
          if (!(body?.name || "").trim()) throw mockErr(422, "validation_failed", "name is required", "name");
          if (!(body?.body || "").trim()) throw mockErr(422, "validation_failed", "body is required", "body");
          const kind = body.kind || "user";
          if (kind === "system" && body.systemPromptId) throw mockErr(422, "validation_failed", "system prompts cannot reference a system prompt", "systemPromptId");
          if (body.systemPromptId && !mockDb.prompts.some((p) => p.id === body.systemPromptId && p.kind === "system")) {
            throw mockErr(422, "validation_failed", "systemPromptId must reference an existing system prompt", "systemPromptId");
          }
          const rec = {
            id: mid(), name: body.name.trim(), kind,
            categoryId: body.categoryId || "", systemPromptId: body.systemPromptId || "",
            tags: (body.tags || []).map((t) => t.toLowerCase()).sort(),
            body: body.body, variables: body.variables || [], version: 1,
            createdAt: now(), updatedAt: now(),
          };
          mockDb.prompts.push(rec);
          return rec;
        }
      } else if (sub === "notes") {
        return mockList(mockDb.notes.filter((n) => n.promptId === id), params);
      } else {
        const idx = mockDb.prompts.findIndex((p) => p.id === id);
        if (idx < 0) throw mockErr(404, "not_found", "prompt not found");
        const p = mockDb.prompts[idx];
        if (method === "GET") return p;
        if (method === "PUT") {
          const next = { ...p, ...body };
          if (!(next.name || "").trim()) throw mockErr(422, "validation_failed", "name is required", "name");
          if (!(next.body || "").trim()) throw mockErr(422, "validation_failed", "body is required", "body");
          if (next.kind === "system" && next.systemPromptId) throw mockErr(422, "validation_failed", "system prompts cannot reference a system prompt", "systemPromptId");
          if (next.systemPromptId && !mockDb.prompts.some((x) => x.id === next.systemPromptId && x.kind === "system")) {
            throw mockErr(422, "validation_failed", "systemPromptId must reference an existing system prompt", "systemPromptId");
          }
          next.tags = (next.tags || []).map((t) => t.toLowerCase()).sort();
          next.version = (p.version || 1) + 1;
          mockDb.prompts[idx] = touch(next);
          return next;
        }
        if (method === "DELETE") {
          const referenced = mockDb.prompts.some((x) => x.systemPromptId === id);
          if (referenced && params.get("force") !== "true") {
            throw mockErr(422, "validation_failed", "system prompt is referenced by user prompts; pass force=true");
          }
          mockDb.prompts.forEach((x) => { if (x.systemPromptId === id) x.systemPromptId = ""; });
          mockDb.prompts.splice(idx, 1);
          return null;
        }
      }
    }

    if (coll === "notes") {
      if (!id) {
        if (method === "GET") return mockList(mockDb.notes, params);
        if (method === "POST") {
          if (!(body?.title || "").trim()) throw mockErr(422, "validation_failed", "title is required", "title");
          const rec = {
            id: mid(), title: body.title.trim(),
            categoryId: body.categoryId || "", promptId: body.promptId || "",
            tags: (body.tags || []).map((t) => t.toLowerCase()).sort(),
            body: body.body || "", createdAt: now(), updatedAt: now(),
          };
          mockDb.notes.push(rec);
          return rec;
        }
      } else {
        const idx = mockDb.notes.findIndex((n) => n.id === id);
        if (idx < 0) throw mockErr(404, "not_found", "note not found");
        const n = mockDb.notes[idx];
        if (method === "GET") return n;
        if (method === "PUT") {
          const next = { ...n, ...body };
          if (!(next.title || "").trim()) throw mockErr(422, "validation_failed", "title is required", "title");
          next.tags = (next.tags || []).map((t) => t.toLowerCase()).sort();
          mockDb.notes[idx] = touch(next);
          return next;
        }
        if (method === "DELETE") { mockDb.notes.splice(idx, 1); return null; }
      }
    }

    if (coll === "tags") {
      const all = new Set();
      [...mockDb.prompts, ...mockDb.notes].forEach((r) => (r.tags || []).forEach((t) => all.add(t)));
      return { items: [...all].sort(), total: all.size };
    }

    throw mockErr(404, "not_found", `unknown mock route: ${method} ${rawPath}`);
  }

  /* ================= State ================= */

  const state = {
    v2: MOCK, // categories/kind support; feature-detected on load
    categories: [],
    prompts: [],
    notes: [],
    tags: [],
    // selection / filters
    treeSel: { type: "all" }, // {type:"all"|"uncategorized"|"category"|"prompts"|"notes", id?}
    typeFilter: "all", // all | prompt | note
    search: "",
    tagFilter: new Set(),
    selected: null, // {type:"prompt"|"note", id}
    loading: true,
    collapsed: new Set(JSON.parse(localStorage.getItem("cue.collapsed") || "[]")),
  };

  /* ================= Theme & accent ================= */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cue.theme", theme);
  }
  function initTheme() {
    const saved = localStorage.getItem("cue.theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
    const accent = localStorage.getItem("cue.accent") || "indigo";
    document.documentElement.dataset.accent = accent;
    document.querySelectorAll(".accent-dot").forEach((d) =>
      d.classList.toggle("active", d.dataset.accent === accent));
  }
  $("theme-toggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  $("accent-picker").addEventListener("click", (e) => {
    const dot = e.target.closest(".accent-dot");
    if (!dot) return;
    document.documentElement.dataset.accent = dot.dataset.accent;
    localStorage.setItem("cue.accent", dot.dataset.accent);
    document.querySelectorAll(".accent-dot").forEach((d) => d.classList.toggle("active", d === dot));
  });

  /* ================= Data loading ================= */

  async function detectV2() {
    if (MOCK) { state.v2 = true; return; }
    try {
      await api("/categories");
      state.v2 = true;
    } catch (err) {
      state.v2 = false;
    }
  }

  async function loadAll() {
    state.loading = true;
    renderList();
    try {
      const [prompts, notes, tags, categories] = await Promise.all([
        api("/prompts"),
        api("/notes"),
        api("/tags").catch(() => ({ items: [] })),
        state.v2 ? api("/categories").catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      ]);
      state.prompts = prompts.items || [];
      state.notes = notes.items || [];
      state.tags = tags.items || [];
      state.categories = categories.items || [];
    } catch (err) {
      toast(`${err.code || "error"}: ${err.message}`, "error");
    }
    state.loading = false;
    renderAll();
  }

  /* ================= Derived data ================= */

  const catById = () => Object.fromEntries(state.categories.map((c) => [c.id, c]));

  function catChildren(parentId) {
    return state.categories
      .filter((c) => (c.parentId || "") === (parentId || ""))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function catDescendants(id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of state.categories) {
        if (c.parentId && out.has(c.parentId) && !out.has(c.id)) { out.add(c.id); grew = true; }
      }
    }
    return out;
  }

  function countsFor(catId) {
    const ids = catDescendants(catId);
    const p = state.prompts.filter((x) => ids.has(x.categoryId)).length;
    const n = state.notes.filter((x) => ids.has(x.categoryId)).length;
    return p + n;
  }

  function catPath(catId) {
    const map = catById();
    const parts = [];
    let cur = map[catId];
    let guard = 0;
    while (cur && guard++ < 20) {
      parts.unshift(cur.name);
      cur = map[cur.parentId];
    }
    return parts.join(" / ");
  }

  function visibleRecords() {
    let prompts = state.prompts.map((p) => ({ ...p, _type: "prompt" }));
    let notes = state.notes.map((n) => ({ ...n, _type: "note" }));

    const sel = state.treeSel;
    if (sel.type === "category") {
      const ids = catDescendants(sel.id);
      prompts = prompts.filter((p) => ids.has(p.categoryId));
      notes = notes.filter((n) => ids.has(n.categoryId));
    } else if (sel.type === "uncategorized") {
      prompts = prompts.filter((p) => !p.categoryId);
      notes = notes.filter((n) => !n.categoryId);
    } else if (sel.type === "tagGroup") {
      prompts = prompts.filter((p) => (sel.id ? (p.tags || []).includes(sel.id) : !(p.tags || []).length));
      notes = notes.filter((n) => (sel.id ? (n.tags || []).includes(sel.id) : !(n.tags || []).length));
    }

    let records = [...prompts, ...notes];
    if (state.typeFilter !== "all") records = records.filter((r) => r._type === state.typeFilter);
    if (state.tagFilter.size) {
      records = records.filter((r) => [...state.tagFilter].every((t) => (r.tags || []).includes(t)));
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      records = records.filter((r) =>
        [(r.name || r.title || ""), r.body || "", (r.tags || []).join(" ")].join("\n").toLowerCase().includes(q));
    }
    records.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return records;
  }

  /* ================= Tree rendering ================= */

  const ICONS = {
    all: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M1.5 3a1.5 1.5 0 0 1 3 0v.5h7V3a1.5 1.5 0 1 1 1.5 1.5h-.5v7h.5a1.5 1.5 0 1 1-1.5 1.5v-.5h-7v.5A1.5 1.5 0 1 1 3 11.5h.5v-7H3A1.5 1.5 0 0 1 1.5 3zm3 1.5v7h7v-7h-7z"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M1.75 2.5a.75.75 0 0 0-.75.75v9.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75H7.81L6.28 3.03a1.75 1.75 0 0 0-1.238-.53H1.75zm.75 1.5h2.54c.066 0 .13.026.177.073L6.75 5.5h6.75v6.5h-11V4z"/></svg>',
    inbox: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2.8 2.5a.75.75 0 0 0-.7.48L.55 7.03a.75.75 0 0 0-.05.27v5.2c0 .414.336.75.75.75h13.5a.75.75 0 0 0 .75-.75V7.3a.75.75 0 0 0-.05-.27L13.9 2.98a.75.75 0 0 0-.7-.48H2.8zm.52 1.5h9.36l1.2 3H10.5a.75.75 0 0 0-.75.75 1.75 1.75 0 1 1-3.5 0A.75.75 0 0 0 5.5 7H2.12l1.2-3zM2 8.5h2.9a3.25 3.25 0 0 0 6.2 0H14v3.25H2V8.5z"/></svg>',
    tag: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2 2.75A.75.75 0 0 1 2.75 2h4.69c.464 0 .909.184 1.237.513l5.31 5.31a1.75 1.75 0 0 1 0 2.474l-3.69 3.69a1.75 1.75 0 0 1-2.474 0l-5.31-5.31A1.75 1.75 0 0 1 2 7.44V2.75zm1.5.75v3.94c0 .066.026.13.073.177l5.31 5.31a.25.25 0 0 0 .354 0l3.69-3.69a.25.25 0 0 0 0-.354l-5.31-5.31a.25.25 0 0 0-.177-.073H3.5zM5.75 5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z"/></svg>',
    prompt: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zm.94 3.22a.75.75 0 0 1 1.06-.03l2.25 2.1a.75.75 0 0 1 0 1.1l-2.25 2.1a.75.75 0 1 1-1.03-1.09L5.15 7.85 3.47 6.28a.75.75 0 0 1-.03-1.06zM8.25 10a.75.75 0 0 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5z"/></svg>',
    note: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M3.5 1A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h6.086a1.5 1.5 0 0 0 1.06-.44l2.915-2.914a1.5 1.5 0 0 0 .439-1.06V2.5A1.5 1.5 0 0 0 12.5 1h-9zm0 1.5h9v8h-2.75a.75.75 0 0 0-.75.75v2.25H3.5v-11zM5 5.25A.75.75 0 0 1 5.75 4.5h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 5.25zM5.75 7a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5z"/></svg>',
  };

  function treeRow({ key, label, icon, count, depth, hasChildren, open, active, addBtn }) {
    return `
      <div class="tree-row ${active ? "active" : ""}" data-key="${esc(key)}" role="treeitem" tabindex="0" style="padding-left:${6 + depth * 12}px">
        <span class="tree-caret ${hasChildren ? (open ? "open" : "") : "leaf"}" data-caret="${esc(key)}">
          <svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M5.7 13.7a1 1 0 0 1 0-1.4L10 8 5.7 3.7a1 1 0 0 1 1.4-1.4l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.4 0z"/></svg>
        </span>
        <span class="tree-icon">${icon}</span>
        <span class="tree-label">${esc(label)}</span>
        ${addBtn ? `<span class="tree-row-add" data-add="${esc(addBtn)}" title="Add subcategory"><svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg></span>` : ""}
        ${count !== undefined ? `<span class="tree-count">${count}</span>` : ""}
      </div>`;
  }

  function renderCatSubtree(parentId, depth) {
    let html = "";
    for (const c of catChildren(parentId)) {
      const kids = catChildren(c.id);
      const open = !state.collapsed.has(c.id);
      const active = state.treeSel.type === "category" && state.treeSel.id === c.id;
      html += treeRow({
        key: `cat:${c.id}`, label: c.name, icon: ICONS.folder,
        count: countsFor(c.id), depth, hasChildren: kids.length > 0, open, active,
        addBtn: c.id,
      });
      if (kids.length && open) {
        html += `<div class="tree-children">${renderCatSubtree(c.id, 0)}</div>`;
      }
    }
    return html;
  }

  function renderTree() {
    const total = state.prompts.length + state.notes.length;
    const uncat = state.prompts.filter((p) => !p.categoryId).length + state.notes.filter((n) => !n.categoryId).length;
    let html = treeRow({
      key: "all", label: "All items", icon: ICONS.all, count: total, depth: 0,
      hasChildren: false, active: state.treeSel.type === "all",
    });

    if (state.v2) {
      html += `<div class="list-group-label" style="display:flex;align-items:center;justify-content:space-between;padding-right:6px">
        <span>Categories</span>
        <span class="tree-row-add" style="opacity:1" data-add="" title="New category">
          <svg viewBox="0 0 16 16" width="10" height="10"><path fill="currentColor" d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg>
        </span></div>`;
      html += renderCatSubtree("", 0);
      html += treeRow({
        key: "uncategorized", label: "Uncategorized", icon: ICONS.inbox, count: uncat, depth: 0,
        hasChildren: false, active: state.treeSel.type === "uncategorized",
      });
    } else {
      // v1 fallback: flat grouping by tag
      html += `<div class="list-group-label">Tags (v1 mode)</div>`;
      const tagCounts = {};
      [...state.prompts, ...state.notes].forEach((r) => (r.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
      for (const t of Object.keys(tagCounts).sort()) {
        html += treeRow({
          key: `tagGroup:${t}`, label: t, icon: ICONS.tag, count: tagCounts[t], depth: 0,
          hasChildren: false, active: state.treeSel.type === "tagGroup" && state.treeSel.id === t,
        });
      }
      const untagged = [...state.prompts, ...state.notes].filter((r) => !(r.tags || []).length).length;
      html += treeRow({
        key: "tagGroup:", label: "Untagged", icon: ICONS.inbox, count: untagged, depth: 0,
        hasChildren: false, active: state.treeSel.type === "tagGroup" && state.treeSel.id === "",
      });
    }
    $("tree").innerHTML = html;
  }

  $("tree").addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    if (add) {
      e.stopPropagation();
      openCategoryModal(null, add.dataset.add || "");
      return;
    }
    const caret = e.target.closest("[data-caret]");
    if (caret && !caret.classList.contains("leaf")) {
      const key = caret.dataset.caret;
      if (key.startsWith("cat:")) {
        const id = key.slice(4);
        state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
        localStorage.setItem("cue.collapsed", JSON.stringify([...state.collapsed]));
        renderTree();
        e.stopPropagation();
        return;
      }
    }
    const row = e.target.closest(".tree-row");
    if (!row) return;
    selectTreeKey(row.dataset.key);
  });
  $("tree").addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row || !row.dataset.key.startsWith("cat:")) return;
    e.preventDefault();
    openCategoryModal(row.dataset.key.slice(4));
  });
  $("tree").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".tree-row");
    if (row) { e.preventDefault(); selectTreeKey(row.dataset.key); }
  });

  function selectTreeKey(key) {
    if (key === "all") state.treeSel = { type: "all" };
    else if (key === "uncategorized") state.treeSel = { type: "uncategorized" };
    else if (key.startsWith("cat:")) state.treeSel = { type: "category", id: key.slice(4) };
    else if (key.startsWith("tagGroup:")) state.treeSel = { type: "tagGroup", id: key.slice(9) };
    renderTree();
    renderList();
    renderFilters();
  }

  /* ================= Tag cloud ================= */

  function renderTagCloud() {
    const html = state.tags
      .map((t) => `<button class="tag-pill ${state.tagFilter.has(t) ? "active" : ""}" data-tag="${esc(t)}">${esc(t)}</button>`)
      .join("");
    $("tag-cloud").innerHTML = html || '<span class="field-hint">No tags yet</span>';
  }
  $("tag-cloud").addEventListener("click", (e) => {
    const pill = e.target.closest("[data-tag]");
    if (!pill) return;
    const t = pill.dataset.tag;
    state.tagFilter.has(t) ? state.tagFilter.delete(t) : state.tagFilter.add(t);
    renderTagCloud();
    renderList();
    renderFilters();
  });

  /* ================= Active filter chips ================= */

  function renderFilters() {
    const chips = [];
    if (state.treeSel.type === "category") {
      chips.push({ label: catPath(state.treeSel.id) || "category", clear: () => selectTreeKey("all") });
    } else if (state.treeSel.type === "uncategorized") {
      chips.push({ label: "Uncategorized", clear: () => selectTreeKey("all") });
    } else if (state.treeSel.type === "tagGroup") {
      chips.push({ label: state.treeSel.id || "Untagged", clear: () => selectTreeKey("all") });
    }
    for (const t of state.tagFilter) {
      chips.push({ label: `#${t}`, clear: () => { state.tagFilter.delete(t); renderTagCloud(); renderList(); renderFilters(); } });
    }
    if (state.search) {
      chips.push({ label: `“${state.search}”`, clear: () => { state.search = ""; $("search").value = ""; renderList(); renderFilters(); } });
    }
    const box = $("active-filters");
    box.hidden = chips.length === 0;
    box.innerHTML = "";
    chips.forEach((chip) => {
      const el = document.createElement("span");
      el.className = "filter-chip";
      el.innerHTML = `${esc(chip.label)}<button aria-label="Clear filter">&times;</button>`;
      el.querySelector("button").addEventListener("click", chip.clear);
      box.append(el);
    });
  }

  /* ================= List pane ================= */

  function kindBadge(record) {
    if (record._type === "note") return '<span class="badge badge-note">Note</span>';
    const kind = record.kind || "user";
    return kind === "system"
      ? '<span class="badge badge-system">System</span>'
      : '<span class="badge badge-user">User</span>';
  }

  function renderList() {
    const body = $("list-body");
    if (state.loading) {
      body.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton skeleton-row"></div>').join("");
      return;
    }
    const records = visibleRecords();
    if (!records.length) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⌘</div>
          <div class="empty-title">Nothing here</div>
          <div class="empty-sub">No prompts or notes match the current filters. Create one with the New button, or press Ctrl+K.</div>
        </div>`;
      return;
    }
    body.innerHTML = records
      .map((r) => {
        const title = r._type === "prompt" ? r.name : r.title;
        const active = state.selected && state.selected.type === r._type && state.selected.id === r.id;
        const snippet = (r.body || "").replace(/\s+/g, " ").slice(0, 90);
        const tags = (r.tags || []).slice(0, 4).map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("");
        return `
          <button class="row ${active ? "active" : ""}" data-type="${r._type}" data-id="${esc(r.id)}" role="option">
            <span class="row-top">${kindBadge(r)}<span class="row-title">${esc(title)}</span></span>
            <span class="row-snippet">${esc(snippet)}</span>
            ${tags ? `<span class="row-tags">${tags}</span>` : ""}
          </button>`;
      })
      .join("");
  }

  $("list-body").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    select(row.dataset.type, row.dataset.id);
  });

  document.querySelectorAll(".list-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".list-tab").forEach((t) => t.classList.toggle("active", t === tab));
      state.typeFilter = tab.dataset.type;
      renderList();
    });
  });

  function select(type, id) {
    state.selected = { type, id };
    renderList();
    renderDetail();
    if (window.matchMedia("(max-width: 900px)").matches) {
      $("detail-pane").classList.add("open");
    }
  }

  /* ================= Detail pane ================= */

  function findRecord(sel) {
    if (!sel) return null;
    const list = sel.type === "prompt" ? state.prompts : state.notes;
    return list.find((r) => r.id === sel.id) || null;
  }

  function renderDetail() {
    const box = $("detail-body");
    const rec = findRecord(state.selected);
    if (!rec) {
      state.selected = null;
      box.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✦</div>
          <div class="empty-title">Select an item</div>
          <div class="empty-sub">Pick a prompt or note from the list, or press <kbd>Ctrl</kbd>+<kbd>K</kbd> to jump anywhere.</div>
        </div>`;
      return;
    }
    if (state.selected.type === "prompt") renderPromptDetail(box, rec);
    else renderNoteDetail(box, rec);
  }

  function metaHtml(rec) {
    const parts = [];
    if (state.v2 && rec.categoryId) {
      parts.push(`<span><strong>Category</strong> <a class="meta-link" data-goto-cat="${esc(rec.categoryId)}">${esc(catPath(rec.categoryId) || "?")}</a></span>`);
    }
    if (rec.version) parts.push(`<span><strong>v${rec.version}</strong></span>`);
    parts.push(`<span><strong>Updated</strong> ${fmtDate(rec.updatedAt)}</span>`);
    parts.push(`<span><strong>Created</strong> ${fmtDate(rec.createdAt)}</span>`);
    if ((rec.tags || []).length) {
      parts.push(`<span>${rec.tags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join(" ")}</span>`);
    }
    return `<div class="detail-meta">${parts.join("")}</div>`;
  }

  function renderPromptDetail(box, p) {
    const sys = p.systemPromptId ? state.prompts.find((x) => x.id === p.systemPromptId) : null;
    const attached = state.notes.filter((n) => n.promptId === p.id);
    const kind = p.kind || "user";
    const usedBy = kind === "system" ? state.prompts.filter((x) => x.systemPromptId === p.id) : [];

    box.innerHTML = `
      <div class="detail-inner">
        <div class="detail-head">
          <div>
            <div class="detail-title-row">
              ${kindBadge({ _type: "prompt", kind })}
              <h1 class="detail-title">${esc(p.name)}</h1>
            </div>
          </div>
          <div class="detail-actions">
            <button class="btn btn-ghost detail-close" id="detail-close-btn">Close</button>
            <button class="btn btn-sm" id="copy-btn">Copy body</button>
            <button class="btn btn-sm" id="edit-btn">Edit</button>
            <button class="btn btn-sm btn-danger" id="delete-btn">Delete</button>
          </div>
        </div>
        ${metaHtml(p)}
        ${kind === "user" && sys ? `
          <div class="card">
            <div class="card-head">
              <span>System prompt: <a class="meta-link" data-goto-prompt="${esc(sys.id)}">${esc(sys.name)}</a></span>
              <button class="text-btn" id="toggle-sys">Preview</button>
            </div>
            <div class="sys-preview" id="sys-preview" hidden>
              <pre class="prompt-body">${highlightVars(sys.body)}</pre>
            </div>
          </div>` : ""}
        ${kind === "user" && !sys && p.systemPromptId ? `
          <div class="card"><div class="card-body field-error">References missing system prompt ${esc(p.systemPromptId)}</div></div>` : ""}
        <div class="card">
          <div class="card-head"><span>Body</span>${(p.variables || []).length ? `<span class="field-hint">vars: ${p.variables.map(esc).join(", ")}</span>` : ""}</div>
          <div class="card-body"><pre class="prompt-body">${highlightVars(p.body)}</pre></div>
        </div>
        ${usedBy.length ? `
          <div class="card">
            <div class="card-head"><span>Used by ${usedBy.length} user prompt${usedBy.length > 1 ? "s" : ""}</span></div>
            <div class="card-body tight">
              ${usedBy.map((u) => `<div class="note-item"><a class="meta-link" data-goto-prompt="${esc(u.id)}">${esc(u.name)}</a></div>`).join("")}
            </div>
          </div>` : ""}
        <div class="card">
          <div class="card-head">
            <span>Notes (${attached.length})</span>
            <button class="text-btn" id="add-note-btn">+ Add note</button>
          </div>
          <div class="card-body tight" id="attached-notes">
            ${attached.length
              ? attached.map((n) => `
                <div class="note-item">
                  <div class="note-item-head">
                    <span class="note-item-title">${esc(n.title)}</span>
                    <span class="note-item-actions">
                      <button class="text-btn" data-note-edit="${esc(n.id)}">Edit</button>
                      <button class="text-btn" data-note-detach="${esc(n.id)}">Detach</button>
                      <button class="text-btn danger" data-note-delete="${esc(n.id)}">Delete</button>
                    </span>
                  </div>
                  <div class="md">${renderMarkdown(n.body)}</div>
                </div>`).join("")
              : '<div class="note-item field-hint">No notes attached. Capture usage tips, model quirks, or gotchas here.</div>'}
          </div>
        </div>
      </div>`;

    $("edit-btn").addEventListener("click", () => openPromptModal(p.id));
    $("delete-btn").addEventListener("click", () => deletePrompt(p));
    $("copy-btn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(p.body);
        toast("Prompt body copied", "success");
      } catch {
        toast("Copy failed", "error");
      }
    });
    $("add-note-btn").addEventListener("click", () => openNoteModal(null, { promptId: p.id, categoryId: p.categoryId }));
    const closeBtn = $("detail-close-btn");
    if (closeBtn) closeBtn.addEventListener("click", () => $("detail-pane").classList.remove("open"));
    const toggleSys = $("toggle-sys");
    if (toggleSys) toggleSys.addEventListener("click", () => {
      const pv = $("sys-preview");
      pv.hidden = !pv.hidden;
      toggleSys.textContent = pv.hidden ? "Preview" : "Hide";
    });
    wireDetailLinks(box);
    box.querySelectorAll("[data-note-edit]").forEach((b) =>
      b.addEventListener("click", () => openNoteModal(b.dataset.noteEdit)));
    box.querySelectorAll("[data-note-detach]").forEach((b) =>
      b.addEventListener("click", () => detachNote(b.dataset.noteDetach)));
    box.querySelectorAll("[data-note-delete]").forEach((b) =>
      b.addEventListener("click", () => deleteNote(b.dataset.noteDelete)));
  }

  function renderNoteDetail(box, n) {
    const parent = n.promptId ? state.prompts.find((p) => p.id === n.promptId) : null;
    box.innerHTML = `
      <div class="detail-inner">
        <div class="detail-head">
          <div class="detail-title-row">
            ${kindBadge({ _type: "note" })}
            <h1 class="detail-title">${esc(n.title)}</h1>
          </div>
          <div class="detail-actions">
            <button class="btn btn-ghost detail-close" id="detail-close-btn">Close</button>
            <button class="btn btn-sm" id="edit-btn">Edit</button>
            <button class="btn btn-sm btn-danger" id="delete-btn">Delete</button>
          </div>
        </div>
        ${metaHtml(n)}
        ${parent ? `<div class="card"><div class="card-body">Attached to prompt <a class="meta-link" data-goto-prompt="${esc(parent.id)}">${esc(parent.name)}</a></div></div>` : ""}
        <div class="card"><div class="card-body md">${renderMarkdown(n.body)}</div></div>
      </div>`;
    $("edit-btn").addEventListener("click", () => openNoteModal(n.id));
    $("delete-btn").addEventListener("click", () => deleteNote(n.id));
    const closeBtn = $("detail-close-btn");
    if (closeBtn) closeBtn.addEventListener("click", () => $("detail-pane").classList.remove("open"));
    wireDetailLinks(box);
  }

  function wireDetailLinks(box) {
    box.querySelectorAll("[data-goto-prompt]").forEach((a) =>
      a.addEventListener("click", () => select("prompt", a.dataset.gotoPrompt)));
    box.querySelectorAll("[data-goto-cat]").forEach((a) =>
      a.addEventListener("click", () => selectTreeKey(`cat:${a.dataset.gotoCat}`)));
  }

  /* ================= Modals ================= */

  function openModal(html) {
    $("modal").innerHTML = html;
    $("modal-overlay").hidden = false;
    const first = $("modal").querySelector("input, select, textarea");
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal() {
    $("modal-overlay").hidden = true;
    $("modal").innerHTML = "";
  }
  $("modal-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("modal-overlay")) closeModal();
  });

  function catOptions(selected, excludeId) {
    const opts = ['<option value="">(none)</option>'];
    const walk = (parentId, depth) => {
      for (const c of catChildren(parentId)) {
        if (excludeId && catDescendants(excludeId).has(c.id)) continue;
        opts.push(`<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${"&nbsp;".repeat(depth * 3)}${esc(c.name)}</option>`);
        walk(c.id, depth + 1);
      }
    };
    walk("", 0);
    return opts.join("");
  }

  function editorField(id, label, value) {
    return `
      <div class="field">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <label for="${id}">${label}</label>
          <div class="editor-tabs">
            <button type="button" class="editor-tab active" data-edt="${id}" data-mode="write">Write</button>
            <button type="button" class="editor-tab" data-edt="${id}" data-mode="preview">Preview</button>
          </div>
        </div>
        <textarea id="${id}" class="textarea" spellcheck="false">${esc(value)}</textarea>
        <div class="md-preview md" id="${id}-preview" hidden></div>
        <span class="field-hint">Markdown supported</span>
      </div>`;
  }
  function wireEditor(id) {
    document.querySelectorAll(`[data-edt="${id}"]`).forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(`[data-edt="${id}"]`).forEach((t) => t.classList.toggle("active", t === tab));
        const preview = tab.dataset.mode === "preview";
        $(id).hidden = preview;
        $(`${id}-preview`).hidden = !preview;
        if (preview) $(`${id}-preview`).innerHTML = renderMarkdown($(id).value) || '<span class="field-hint">Nothing to preview</span>';
      });
    });
  }

  /* ---- Prompt modal ---- */

  function openPromptModal(id = null, defaults = {}) {
    const p = id ? state.prompts.find((x) => x.id === id) : null;
    const kind = p?.kind || defaults.kind || "user";
    const systemPrompts = state.prompts.filter((x) => (x.kind || "user") === "system" && x.id !== id);
    openModal(`
      <div class="modal-head"><span>${p ? "Edit prompt" : "New prompt"}</span><button class="icon-btn" id="modal-x">✕</button></div>
      <form id="prompt-form">
        <div class="modal-body">
          <div class="field">
            <label for="f-name">Name</label>
            <input id="f-name" class="input" value="${esc(p?.name || "")}" required />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="f-kind">Kind</label>
              <select id="f-kind" class="select">
                <option value="user" ${kind === "user" ? "selected" : ""}>User prompt</option>
                <option value="system" ${kind === "system" ? "selected" : ""}>System prompt</option>
              </select>
            </div>
            ${state.v2 ? `
            <div class="field">
              <label for="f-cat">Category</label>
              <select id="f-cat" class="select">${catOptions(p?.categoryId || defaults.categoryId || "")}</select>
            </div>` : ""}
          </div>
          <div class="field" id="f-sys-field" ${kind === "system" ? "hidden" : ""}>
            <label for="f-sys">System prompt (optional)</label>
            <select id="f-sys" class="select">
              <option value="">(none)</option>
              ${systemPrompts.map((s) => `<option value="${esc(s.id)}" ${p?.systemPromptId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
            </select>
            ${systemPrompts.length ? "" : '<span class="field-hint">No system prompts exist yet — create one with Kind = System prompt.</span>'}
          </div>
          <div class="field">
            <label for="f-tags">Tags</label>
            <input id="f-tags" class="input" value="${esc((p?.tags || []).join(", "))}" placeholder="comma, separated" />
          </div>
          <div class="field">
            <label for="f-vars">Variables</label>
            <input id="f-vars" class="input" value="${esc((p?.variables || []).join(", "))}" placeholder="name, topic — referenced as {{name}}" />
          </div>
          ${editorField("f-body", "Body", p?.body || "")}
          <div class="field-error" id="f-error"></div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${p ? "Save changes" : "Create prompt"}</button>
        </div>
      </form>`);
    wireEditor("f-body");
    $("modal-x").addEventListener("click", closeModal);
    $("modal-cancel").addEventListener("click", closeModal);
    $("f-kind").addEventListener("change", () => {
      $("f-sys-field").hidden = $("f-kind").value === "system";
    });
    $("prompt-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        name: $("f-name").value.trim(),
        kind: $("f-kind").value,
        tags: csvToList($("f-tags").value),
        variables: csvToList($("f-vars").value),
        body: $("f-body").value,
      };
      if (state.v2) {
        payload.categoryId = $("f-cat") ? $("f-cat").value : "";
        payload.systemPromptId = payload.kind === "user" ? $("f-sys").value : "";
      }
      try {
        const saved = p
          ? await api(`/prompts/${p.id}`, { method: "PUT", body: JSON.stringify(payload) })
          : await api("/prompts", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        toast(p ? "Prompt updated" : "Prompt created", "success");
        await loadAll();
        select("prompt", saved.id);
      } catch (err) {
        $("f-error").textContent = `${err.code || "error"}: ${err.message}${err.field ? ` (${err.field})` : ""}`;
      }
    });
  }

  async function deletePrompt(p) {
    if (!confirm(`Delete prompt “${p.name}”?`)) return;
    try {
      await api(`/prompts/${p.id}`, { method: "DELETE" });
    } catch (err) {
      if (err.code === "validation_failed") {
        if (!confirm(`${err.message}\n\nForce delete and clear references?`)) return;
        try {
          await api(`/prompts/${p.id}?force=true`, { method: "DELETE" });
        } catch (err2) {
          toast(`${err2.code}: ${err2.message}`, "error");
          return;
        }
      } else {
        toast(`${err.code}: ${err.message}`, "error");
        return;
      }
    }
    toast("Prompt deleted", "success");
    if (state.selected?.type === "prompt" && state.selected.id === p.id) state.selected = null;
    await loadAll();
  }

  /* ---- Note modal ---- */

  function openNoteModal(id = null, defaults = {}) {
    const n = id ? state.notes.find((x) => x.id === id) : null;
    const prompts = state.prompts.slice().sort((a, b) => a.name.localeCompare(b.name));
    const promptId = n?.promptId ?? defaults.promptId ?? "";
    openModal(`
      <div class="modal-head"><span>${n ? "Edit note" : "New note"}</span><button class="icon-btn" id="modal-x">✕</button></div>
      <form id="note-form">
        <div class="modal-body">
          <div class="field">
            <label for="f-title">Title</label>
            <input id="f-title" class="input" value="${esc(n?.title || "")}" required />
          </div>
          <div class="field-row">
            ${state.v2 ? `
            <div class="field">
              <label for="f-cat">Category</label>
              <select id="f-cat" class="select">${catOptions(n?.categoryId ?? defaults.categoryId ?? "")}</select>
            </div>` : ""}
            <div class="field">
              <label for="f-prompt">Attach to prompt (optional)</label>
              <select id="f-prompt" class="select">
                <option value="">(standalone note)</option>
                ${prompts.map((pr) => `<option value="${esc(pr.id)}" ${promptId === pr.id ? "selected" : ""}>${esc(pr.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="f-tags">Tags</label>
            <input id="f-tags" class="input" value="${esc((n?.tags || []).join(", "))}" placeholder="comma, separated" />
          </div>
          ${editorField("f-body", "Body", n?.body || "")}
          <div class="field-error" id="f-error"></div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${n ? "Save changes" : "Create note"}</button>
        </div>
      </form>`);
    wireEditor("f-body");
    $("modal-x").addEventListener("click", closeModal);
    $("modal-cancel").addEventListener("click", closeModal);
    $("note-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        title: $("f-title").value.trim(),
        tags: csvToList($("f-tags").value),
        body: $("f-body").value,
      };
      if (state.v2) {
        payload.categoryId = $("f-cat") ? $("f-cat").value : "";
        payload.promptId = $("f-prompt").value;
      } else {
        payload.promptId = $("f-prompt").value;
      }
      try {
        const saved = n
          ? await api(`/notes/${n.id}`, { method: "PUT", body: JSON.stringify(payload) })
          : await api("/notes", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        toast(n ? "Note updated" : "Note created", "success");
        const keep = state.selected;
        await loadAll();
        if (keep?.type === "prompt") select(keep.type, keep.id);
        else select("note", saved.id);
      } catch (err) {
        $("f-error").textContent = `${err.code || "error"}: ${err.message}${err.field ? ` (${err.field})` : ""}`;
      }
    });
  }

  async function detachNote(id) {
    const n = state.notes.find((x) => x.id === id);
    if (!n) return;
    try {
      await api(`/notes/${id}`, { method: "PUT", body: JSON.stringify({ ...n, promptId: "" }) });
      toast("Note detached", "success");
      const keep = state.selected;
      await loadAll();
      if (keep) select(keep.type, keep.id);
    } catch (err) {
      toast(`${err.code}: ${err.message}`, "error");
    }
  }

  async function deleteNote(id) {
    const n = state.notes.find((x) => x.id === id);
    if (!n || !confirm(`Delete note “${n.title}”?`)) return;
    try {
      await api(`/notes/${id}`, { method: "DELETE" });
      toast("Note deleted", "success");
      if (state.selected?.type === "note" && state.selected.id === id) state.selected = null;
      const keep = state.selected;
      await loadAll();
      if (keep) select(keep.type, keep.id);
    } catch (err) {
      toast(`${err.code}: ${err.message}`, "error");
    }
  }

  /* ---- Category modal ---- */

  function openCategoryModal(id = null, parentId = "") {
    const c = id ? state.categories.find((x) => x.id === id) : null;
    openModal(`
      <div class="modal-head"><span>${c ? "Edit category" : "New category"}</span><button class="icon-btn" id="modal-x">✕</button></div>
      <form id="cat-form">
        <div class="modal-body">
          <div class="field">
            <label for="f-name">Name</label>
            <input id="f-name" class="input" value="${esc(c?.name || "")}" required />
          </div>
          <div class="field">
            <label for="f-parent">Parent category</label>
            <select id="f-parent" class="select">${catOptions(c?.parentId ?? parentId, c?.id)}</select>
          </div>
          <div class="field-error" id="f-error"></div>
        </div>
        <div class="modal-foot">
          ${c ? '<button type="button" class="btn btn-danger" id="cat-delete" style="margin-right:auto">Delete</button>' : ""}
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">${c ? "Save" : "Create"}</button>
        </div>
      </form>`);
    $("modal-x").addEventListener("click", closeModal);
    $("modal-cancel").addEventListener("click", closeModal);
    const del = $("cat-delete");
    if (del) del.addEventListener("click", async () => {
      try {
        await api(`/categories/${c.id}`, { method: "DELETE" });
      } catch (err) {
        if (err.code === "validation_failed") {
          if (!confirm(`${err.message}\n\nForce delete? Children move up; items become uncategorized.`)) return;
          try {
            await api(`/categories/${c.id}?force=true`, { method: "DELETE" });
          } catch (err2) {
            $("f-error").textContent = `${err2.code}: ${err2.message}`;
            return;
          }
        } else {
          $("f-error").textContent = `${err.code}: ${err.message}`;
          return;
        }
      }
      closeModal();
      toast("Category deleted", "success");
      if (state.treeSel.type === "category" && state.treeSel.id === c.id) state.treeSel = { type: "all" };
      await loadAll();
    });
    $("cat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = { name: $("f-name").value.trim(), parentId: $("f-parent").value };
      try {
        c
          ? await api(`/categories/${c.id}`, { method: "PUT", body: JSON.stringify(payload) })
          : await api("/categories", { method: "POST", body: JSON.stringify(payload) });
        closeModal();
        toast(c ? "Category updated" : "Category created", "success");
        await loadAll();
      } catch (err) {
        $("f-error").textContent = `${err.code || "error"}: ${err.message}${err.field ? ` (${err.field})` : ""}`;
      }
    });
  }

  /* ---- New item chooser ---- */

  $("new-btn").addEventListener("click", () => {
    const defaults = state.treeSel.type === "category" ? { categoryId: state.treeSel.id } : {};
    openModal(`
      <div class="modal-head"><span>Create</span><button class="icon-btn" id="modal-x">✕</button></div>
      <div class="modal-body">
        <button class="btn" id="new-user-prompt" style="justify-content:flex-start">📝&nbsp; User prompt — a reusable prompt you send to a model</button>
        <button class="btn" id="new-system-prompt" style="justify-content:flex-start">⚙️&nbsp; System prompt — a persona/instructions other prompts reference</button>
        <button class="btn" id="new-note" style="justify-content:flex-start">🗒️&nbsp; Note — standalone or attached to a prompt</button>
        ${state.v2 ? '<button class="btn" id="new-category" style="justify-content:flex-start">📁&nbsp; Category — organize the tree</button>' : ""}
      </div>`);
    $("modal-x").addEventListener("click", closeModal);
    $("new-user-prompt").addEventListener("click", () => openPromptModal(null, { ...defaults, kind: "user" }));
    $("new-system-prompt").addEventListener("click", () => openPromptModal(null, { ...defaults, kind: "system" }));
    $("new-note").addEventListener("click", () => openNoteModal(null, defaults));
    const nc = $("new-category");
    if (nc) nc.addEventListener("click", () => openCategoryModal(null, defaults.categoryId || ""));
  });

  /* ================= Search ================= */

  $("search").addEventListener("input", debounce(() => {
    state.search = $("search").value.trim();
    renderList();
    renderFilters();
  }, 150));

  /* ================= Command palette ================= */

  const palette = {
    open: false,
    items: [],
    selIndex: 0,
  };

  function paletteCommands() {
    const cmds = [
      { label: "New user prompt", act: () => openPromptModal(null, { kind: "user" }) },
      { label: "New system prompt", act: () => openPromptModal(null, { kind: "system" }) },
      { label: "New note", act: () => openNoteModal(null) },
      { label: "Toggle theme", act: () => $("theme-toggle").click() },
      { label: "Show all items", act: () => selectTreeKey("all") },
    ];
    if (state.v2) cmds.splice(3, 0, { label: "New category", act: () => openCategoryModal() });
    return cmds;
  }

  function openPalette() {
    palette.open = true;
    $("palette-overlay").hidden = false;
    $("palette-input").value = "";
    renderPalette("");
    setTimeout(() => $("palette-input").focus(), 20);
  }
  function closePalette() {
    palette.open = false;
    $("palette-overlay").hidden = true;
  }

  function renderPalette(query) {
    const q = query.toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const items = [];

    const cmds = paletteCommands().filter((c) => match(c.label));
    if (cmds.length) {
      items.push({ section: "Commands" });
      cmds.forEach((c) => items.push({ label: c.label, act: c.act }));
    }
    const prompts = state.prompts.filter((p) => match(p.name)).slice(0, 8);
    if (prompts.length) {
      items.push({ section: "Prompts" });
      prompts.forEach((p) => items.push({
        label: p.name,
        badge: (p.kind || "user") === "system" ? "system" : "user",
        act: () => select("prompt", p.id),
      }));
    }
    const notes = state.notes.filter((n) => match(n.title)).slice(0, 6);
    if (notes.length) {
      items.push({ section: "Notes" });
      notes.forEach((n) => items.push({ label: n.title, badge: "note", act: () => select("note", n.id) }));
    }
    if (state.v2) {
      const cats = state.categories.filter((c) => match(c.name)).slice(0, 5);
      if (cats.length) {
        items.push({ section: "Categories" });
        cats.forEach((c) => items.push({ label: catPath(c.id), act: () => selectTreeKey(`cat:${c.id}`) }));
      }
    }

    palette.items = items;
    palette.selIndex = items.findIndex((i) => !i.section);
    drawPalette();
  }

  function drawPalette() {
    const box = $("palette-results");
    if (!palette.items.length) {
      box.innerHTML = '<div class="palette-empty">No results</div>';
      return;
    }
    box.innerHTML = palette.items
      .map((item, i) => {
        if (item.section) return `<div class="palette-section">${esc(item.section)}</div>`;
        const badge = item.badge
          ? `<span class="badge badge-${item.badge === "note" ? "note" : item.badge === "system" ? "system" : "user"}">${item.badge}</span>`
          : "";
        return `<button class="palette-item ${i === palette.selIndex ? "selected" : ""}" data-pi="${i}">${esc(item.label)}${badge}</button>`;
      })
      .join("");
    const sel = box.querySelector(".palette-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function movePaletteSel(dir) {
    const n = palette.items.length;
    let i = palette.selIndex;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!palette.items[i].section) { palette.selIndex = i; break; }
    }
    drawPalette();
  }

  $("palette-input").addEventListener("input", () => renderPalette($("palette-input").value));
  $("palette-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); movePaletteSel(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePaletteSel(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const item = palette.items[palette.selIndex];
      if (item && item.act) { closePalette(); item.act(); }
    }
  });
  $("palette-results").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pi]");
    if (!btn) return;
    const item = palette.items[Number(btn.dataset.pi)];
    if (item && item.act) { closePalette(); item.act(); }
  });
  $("palette-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("palette-overlay")) closePalette();
  });
  $("palette-btn").addEventListener("click", openPalette);

  /* ================= Global keyboard ================= */

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.open ? closePalette() : openPalette();
      return;
    }
    if (e.key === "Escape") {
      if (palette.open) { closePalette(); return; }
      if (!$("modal-overlay").hidden) { closeModal(); return; }
      $("detail-pane").classList.remove("open");
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); $("search").focus(); return; }
    if (e.key.toLowerCase() === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      $("new-btn").click();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const records = visibleRecords();
      if (!records.length) return;
      e.preventDefault();
      let idx = records.findIndex((r) => state.selected && r._type === state.selected.type && r.id === state.selected.id);
      idx = idx < 0 ? 0 : Math.min(Math.max(idx + (e.key === "ArrowDown" ? 1 : -1), 0), records.length - 1);
      select(records[idx]._type, records[idx].id);
    }
  });

  /* ================= Render all & init ================= */

  function renderAll() {
    renderTree();
    renderTagCloud();
    renderList();
    renderFilters();
    renderDetail();
  }

  async function init() {
    initTheme();
    if (MOCK) {
      seedMock();
      $("mock-badge").hidden = false;
    }
    await detectV2();
    $("api-mode").textContent = MOCK ? "mock" : state.v2 ? "api v2" : "api v1";
    await loadAll();
  }

  init();
})();
