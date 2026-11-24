// Content script: injects the chat launcher + panel into YouTube video pages.
// The UI lives in a Shadow DOM so YouTube's CSS can't affect it (and ours can't leak out).

(() => {
  if (window.__askThisVideoLoaded) return;
  window.__askThisVideoLoaded = true;

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const MAX_HISTORY = 10;
  const SUGGESTIONS = ["Summarize the video", "List the key points", "Explain the main idea simply"];

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>',
  };

  // ---------- state ----------------------------------------------------------

  const state = {
    open: false,
    videoId: null,
    ingest: new Map(), // videoId -> { status: "loading" | "ready" | "error", error? }
    convos: new Map(), // videoId -> { messages: [], pending: false }
  };

  function convo(id = state.videoId) {
    if (!state.convos.has(id)) state.convos.set(id, { messages: [], pending: false });
    return state.convos.get(id);
  }

  // ---------- helpers --------------------------------------------------------

  function getVideoId() {
    const url = new URL(location.href);
    let id = null;
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ?? null;
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  function videoTitle() {
    return document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").trim();
  }

  async function api(path, method = "GET", body) {
    try {
      return await chrome.runtime.sendMessage({ type: "api", path, method, body });
    } catch {
      // Happens after the extension is reloaded while this tab stays open.
      return { ok: false, status: 0, error: "The extension was updated. Reload this page to keep chatting." };
    }
  }

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function toSeconds(ts) {
    return ts.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  function seekTo(seconds) {
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return;
    video.currentTime = seconds;
    video.play().catch(() => {});
  }

  // [12:34], [1:02:03] and ranges like [3:54-4:42] (any dash) become clickable chips.
  const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
  const TIMESTAMP_RE = new RegExp(String.raw`\[(${TS})(?:\s*[-‐-―]\s*(${TS}))?\]`, "g");

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(TIMESTAMP_RE, (_m, start, end) => {
        const label = end ? `${start}–${end}` : start;
        return `<button type="button" class="ts" data-t="${toSeconds(start)}" aria-label="Jump to ${start}">${label}</button>`;
      });
  }

  // Minimal, safe markdown: input is HTML-escaped first, then a few patterns are formatted.
  function renderMarkdown(text) {
    const lines = escapeHtml(text).split(/\r?\n/);
    const out = [];
    let list = null; // { tag, items }
    let para = [];

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };

    for (const raw of lines) {
      const line = raw.trim();
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      const numbered = line.match(/^\d+[.)]\s+(.*)$/);
      const heading = line.match(/^#{1,6}\s+(.*)$/);

      if (bullet || numbered) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (list?.tag !== tag) flushList();
        list ??= { tag, items: [] };
        list.items.push((bullet || numbered)[1]);
      } else if (heading) {
        flushPara();
        flushList();
        out.push(`<p class="h">${inline(heading[1])}</p>`);
      } else if (!line) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }

  // ---------- DOM ------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "ask-this-video";
  host.hidden = true;
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL("content/chat-widget.css")}">
    <button class="launcher" type="button" aria-label="Open video chat" title="Ask this video (Alt+Shift+Y)">
      ${ICONS.chat}
    </button>
    <section class="panel" role="dialog" aria-labelledby="atv-title" hidden>
      <header class="head">
        <div class="head-text">
          <h2 id="atv-title">Ask this video</h2>
          <p class="status" data-state="idle"><span class="dot"></span><span class="status-text"></span></p>
        </div>
        <button class="icon-btn" type="button" data-action="reset" aria-label="Start a new conversation" title="New conversation">${ICONS.reset}</button>
        <button class="icon-btn" type="button" data-action="close" aria-label="Close chat" title="Close (Esc)">${ICONS.close}</button>
      </header>
      <div class="log" role="log" aria-live="polite"></div>
      <form class="composer">
        <textarea rows="1" placeholder="Ask about this video" aria-label="Your question" maxlength="2000"></textarea>
        <button class="send" type="submit" aria-label="Send question" title="Send (Enter)">${ICONS.send}</button>
      </form>
    </section>
  `;

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    launcher: $(".launcher"),
    panel: $(".panel"),
    status: $(".status"),
    statusText: $(".status-text"),
    log: $(".log"),
    form: $(".composer"),
    input: $("textarea"),
    send: $(".send"),
  };

  // Keep YouTube's keyboard shortcuts (k, f, m, space...) from firing while typing in the chat.
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // ---------- rendering ------------------------------------------------------

  function renderStatus() {
    const info = state.ingest.get(state.videoId);
    const s = info?.status ?? "loading";
    ui.status.dataset.state = s;
    ui.statusText.textContent =
      s === "ready" ? "Ready" : s === "error" ? "Transcript unavailable" : "Reading the transcript…";
  }

  function messageEl(msg, index) {
    const el = document.createElement("div");
    el.className = `msg ${msg.role === "user" ? "user" : "bot"}`;

    if (msg.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = msg.content;
      el.append(bubble);
    } else if (msg.typing) {
      el.classList.add("typing");
      el.setAttribute("aria-label", "Writing an answer");
      el.innerHTML = "<span></span><span></span><span></span>";
    } else if (msg.error) {
      el.classList.add("error");
      el.innerHTML = `<p></p><button type="button" class="text-btn" data-retry="${index}">Try again</button>`;
      el.querySelector("p").textContent = msg.error;
    } else {
      el.innerHTML = `<div class="md">${renderMarkdown(msg.content)}</div>`;
      if (msg.sources?.length) {
        const row = document.createElement("div");
        row.className = "sources";
        row.innerHTML = '<span class="sources-label">Sources</span>';
        for (const src of msg.sources) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ts";
          b.dataset.t = String(Math.floor(src.start));
          b.textContent = src.timestamp;
          b.title = src.text.length > 160 ? src.text.slice(0, 160) + "…" : src.text;
          b.setAttribute("aria-label", `Jump to ${src.timestamp}`);
          row.append(b);
        }
        el.append(row);
      }
    }
    return el;
  }

  function emptyStateEl() {
    const info = state.ingest.get(state.videoId);
    const el = document.createElement("div");
    el.className = "empty";

    if (info?.status === "error") {
      el.innerHTML = `
        <h3>Can't read this video</h3>
        <p class="error-text"></p>
        <button type="button" class="chip" data-action="reingest">Try again</button>`;
      el.querySelector(".error-text").textContent = info.error;
      return el;
    }

    const title = videoTitle();
    el.innerHTML = `
      <h3>Ask anything about this video</h3>
      <p>Answers come from the transcript. Click a timestamp to jump to that moment.</p>
      <div class="chips"></div>`;
    if (title) {
      const t = document.createElement("p");
      t.className = "video-title";
      t.textContent = title;
      el.querySelector("h3").after(t);
    }
    const chips = el.querySelector(".chips");
    for (const s of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.suggest = s;
      b.textContent = s;
      chips.append(b);
    }
    return el;
  }

  function renderLog() {
    const { messages } = convo();
    ui.log.replaceChildren(
      ...(messages.length ? messages.map(messageEl) : [emptyStateEl()])
    );
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function renderComposer() {
    const c = convo();
    const blocked = state.ingest.get(state.videoId)?.status === "error";
    ui.input.disabled = blocked;
    ui.send.disabled = blocked || c.pending || !ui.input.value.trim();
  }

  function render() {
    host.hidden = !state.videoId;
    ui.panel.hidden = !state.open;
    ui.launcher.hidden = state.open;
    ui.launcher.setAttribute("aria-expanded", String(state.open));
    if (!state.open || !state.videoId) return;
    renderStatus();
    renderLog();
    renderComposer();
  }

  // ---------- actions --------------------------------------------------------

  async function ensureIngested(id, force = false) {
    const current = state.ingest.get(id);
    if (!force && current && current.status !== "error") return;

    state.ingest.set(id, { status: "loading" });
    if (id === state.videoId) render();

    const res = await api(`/videos/${id}/ingest`, "POST");
    state.ingest.set(id, res.ok ? { status: "ready" } : { status: "error", error: res.error });
    if (id === state.videoId) render();
  }

  async function ask(question) {
    const id = state.videoId;
    const c = convo(id);
    if (c.pending || !question) return;

    const history = c.messages
      .filter((m) => !m.error && !m.typing)
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }));

    c.messages.push({ role: "user", content: question });
    c.messages.push({ role: "assistant", typing: true });
    c.pending = true;
    render();

    const res = await api("/chat", "POST", { video_id: id, question, history });

    c.messages.pop(); // typing indicator
    c.messages.push(
      res.ok
        ? { role: "assistant", content: res.data.answer, sources: res.data.sources }
        : { role: "assistant", error: res.error, retry: question }
    );
    c.pending = false;
    if (res.ok) state.ingest.set(id, { status: "ready" }); // /chat ingests on demand
    if (id === state.videoId) render();
  }

  function retry(index) {
    const c = convo();
    const failed = c.messages[index];
    if (!failed?.retry || c.pending) return;
    // Drop the error and the question it belonged to, then ask again.
    c.messages.splice(index - 1, 2);
    ask(failed.retry);
  }

  function submit() {
    const q = ui.input.value.trim();
    if (!q || convo().pending) return;
    ui.input.value = "";
    autosize();
    ask(q);
  }

  function setOpen(open) {
    if (!state.videoId) return;
    state.open = open;
    render();
    if (open) {
      ensureIngested(state.videoId);
      ui.input.focus();
    } else {
      ui.launcher.focus();
    }
  }

  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(ui.input.scrollHeight, 140) + "px";
    renderComposer();
  }

  // ---------- events ---------------------------------------------------------

  ui.launcher.addEventListener("click", () => setOpen(true));

  ui.panel.addEventListener("click", (e) => {
    const target = e.target.closest("button");
    if (!target) return;
    if (target.classList.contains("ts")) seekTo(Number(target.dataset.t));
    else if (target.dataset.action === "close") setOpen(false);
    else if (target.dataset.action === "reset") {
      if (convo().pending) return;
      convo().messages = [];
      render();
      ui.input.focus();
    } else if (target.dataset.action === "reingest") ensureIngested(state.videoId, true);
    else if (target.dataset.suggest) ask(target.dataset.suggest);
    else if (target.dataset.retry) retry(Number(target.dataset.retry));
  });

  ui.panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  });

  ui.form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  ui.input.addEventListener("input", autosize);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "toggle") setOpen(!state.open);
  });

  // Match YouTube's light / dark theme.
  const syncTheme = () => {
    host.dataset.theme = document.documentElement.hasAttribute("dark") ? "dark" : "light";
  };
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["dark"],
  });
  syncTheme();

  // YouTube is a single-page app: watch for in-app navigation.
  let lastHref = "";
  function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;

    const id = getVideoId();
    if (id === state.videoId) return;
    state.videoId = id;
    if (!id) state.open = false;
    else if (state.open) ensureIngested(id);
    render();
  }
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  setInterval(onNavigate, 1000); // fallback if YouTube's event changes

  (document.body || document.documentElement).append(host);
  onNavigate();
})();
