// cue-note UI. Talks to the cue-note API through this server's /api proxy,
// which attaches the API key; the key never reaches the browser.
(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  const state = { kind: "prompts", records: [], selectedId: null, prompts: [] };

  const dom = {
    tabs: Array.from(document.querySelectorAll(".tab")),
    status: el("status"),
    count: el("count"),
    list: el("list"),
    tagCloud: el("tag-cloud"),
    filters: el("filters"),
    q: el("q"),
    tagFilter: el("tag-filter"),
    newRecord: el("new-record"),
    form: el("record-form"),
    recordId: el("record-id"),
    titleLabel: el("title-label"),
    title: el("title"),
    tags: el("tags"),
    variablesField: el("variables-field"),
    variables: el("variables"),
    promptLinkField: el("prompt-link-field"),
    promptId: el("prompt-id"),
    bodyLabel: el("body-label"),
    body: el("body"),
    delete: el("delete"),
    meta: el("meta"),
  };

  const csvToList = (value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

  function setStatus(message, isError = false) {
    dom.status.textContent = message;
    dom.status.classList.toggle("error", isError);
  }

  async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const err = payload && payload.error ? payload.error : {};
      const field = err.field ? ` (${err.field})` : "";
      throw new Error(`${err.code || response.status}: ${err.message || "request failed"}${field}`);
    }
    return payload;
  }

  function listQuery() {
    const params = new URLSearchParams();
    if (dom.q.value.trim()) params.set("q", dom.q.value.trim());
    csvToList(dom.tagFilter.value).forEach((tag) => params.append("tag", tag));
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  function recordTitle(record) {
    return state.kind === "prompts" ? record.name : record.title;
  }

  function renderList() {
    dom.list.textContent = "";
    if (state.records.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No records match.";
      dom.list.append(li);
      return;
    }
    for (const record of state.records) {
      const li = document.createElement("li");
      li.setAttribute("aria-selected", String(record.id === state.selectedId));

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = recordTitle(record) || "(untitled)";

      const sub = document.createElement("div");
      sub.className = "sub";
      const tags = (record.tags || []).map((t) => `#${t}`).join(" ");
      const version = state.kind === "prompts" ? `v${record.version}` : "";
      sub.textContent = [version, tags].filter(Boolean).join("  ");

      li.append(name, sub);
      li.addEventListener("click", () => select(record.id));
      dom.list.append(li);
    }
  }

  function renderTagCloud(inventory) {
    dom.tagCloud.textContent = "";
    const counts = (state.kind === "prompts" ? inventory.prompts : inventory.notes) || [];
    for (const entry of counts) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${entry.tag} (${entry.count})`;
      button.addEventListener("click", () => {
        const current = csvToList(dom.tagFilter.value);
        if (!current.includes(entry.tag)) current.push(entry.tag);
        dom.tagFilter.value = current.join(", ");
        void refresh();
      });
      li.append(button);
      dom.tagCloud.append(li);
    }
  }

  function renderPromptOptions() {
    const selected = dom.promptId.value;
    dom.promptId.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    dom.promptId.append(none);
    for (const prompt of state.prompts) {
      const option = document.createElement("option");
      option.value = prompt.id;
      option.textContent = prompt.name;
      dom.promptId.append(option);
    }
    dom.promptId.value = selected;
  }

  function clearForm() {
    state.selectedId = null;
    dom.recordId.value = "";
    dom.title.value = "";
    dom.tags.value = "";
    dom.variables.value = "";
    dom.promptId.value = "";
    dom.body.value = "";
    dom.delete.hidden = true;
    dom.meta.textContent = "";
    renderList();
  }

  function fillForm(record) {
    dom.recordId.value = record.id;
    dom.title.value = recordTitle(record) || "";
    dom.tags.value = (record.tags || []).join(", ");
    dom.variables.value = (record.variables || []).join(", ");
    dom.promptId.value = record.promptId || "";
    dom.body.value = record.body || "";
    dom.delete.hidden = false;
    dom.meta.textContent =
      state.kind === "prompts"
        ? `v${record.version} · updated ${new Date(record.updatedAt).toLocaleString()}`
        : `updated ${new Date(record.updatedAt).toLocaleString()}`;
  }

  async function select(id) {
    try {
      const record = await request(`/${state.kind}/${encodeURIComponent(id)}`);
      state.selectedId = id;
      fillForm(record);
      renderList();
      setStatus("");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function applyKindToForm() {
    const isPrompts = state.kind === "prompts";
    dom.titleLabel.textContent = isPrompts ? "Name" : "Title";
    dom.bodyLabel.textContent = isPrompts ? "Body / template text" : "Markdown body";
    dom.variablesField.hidden = !isPrompts;
    dom.promptLinkField.hidden = isPrompts;
    dom.tabs.forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.kind === state.kind)));
  }

  async function refresh() {
    try {
      setStatus("Loading…");
      const [page, inventory, promptPage] = await Promise.all([
        request(`/${state.kind}${listQuery()}`),
        request("/tags"),
        state.kind === "notes" ? request("/prompts?limit=1000") : Promise.resolve(null),
      ]);
      state.records = page.items || [];
      dom.count.textContent = `${page.total} total`;
      if (promptPage) {
        state.prompts = promptPage.items || [];
        renderPromptOptions();
      }
      renderList();
      renderTagCloud(inventory);
      setStatus("");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function formPayload() {
    if (state.kind === "prompts") {
      return {
        name: dom.title.value,
        tags: csvToList(dom.tags.value),
        body: dom.body.value,
        variables: csvToList(dom.variables.value),
      };
    }
    return {
      title: dom.title.value,
      tags: csvToList(dom.tags.value),
      body: dom.body.value,
      promptId: dom.promptId.value,
    };
  }

  dom.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.kind = tab.dataset.kind;
      applyKindToForm();
      clearForm();
      void refresh();
    });
  });

  dom.filters.addEventListener("submit", (event) => {
    event.preventDefault();
    void refresh();
  });

  dom.filters.addEventListener("reset", () => {
    window.setTimeout(() => void refresh(), 0);
  });

  dom.newRecord.addEventListener("click", () => {
    clearForm();
    dom.title.focus();
    setStatus("");
  });

  dom.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = dom.recordId.value;
    try {
      const saved = await request(id ? `/${state.kind}/${encodeURIComponent(id)}` : `/${state.kind}`, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(formPayload()),
      });
      state.selectedId = saved.id;
      fillForm(saved);
      await refresh();
      setStatus(id ? "Saved." : "Created.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  dom.delete.addEventListener("click", async () => {
    const id = dom.recordId.value;
    if (!id || !window.confirm("Delete this record?")) return;
    try {
      await request(`/${state.kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
      clearForm();
      await refresh();
      setStatus("Deleted.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  applyKindToForm();
  void refresh();
})();
