const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const el = (id) => document.getElementById(id);
const statusBox = document.querySelector(".status");

function setStatus(state, title, detailHtml = "") {
  statusBox.dataset.state = state;
  el("status-title").textContent = title;
  el("status-detail").innerHTML = detailHtml;
}

function setNote(id, text, tone) {
  const note = el(id);
  note.textContent = text;
  if (tone) note.dataset.tone = tone;
  else delete note.dataset.tone;
}

async function checkBackend() {
  setStatus("checking", "Checking the backend…");
  const res = await chrome.runtime.sendMessage({ type: "api", path: "/health" });
  if (!res?.ok) {
    setStatus(
      "error",
      "Backend not reachable",
      "Start it from <code>backend/</code> with <code>uvicorn app.main:app</code>"
    );
  } else if (!res.data.llm_configured) {
    setStatus("error", "Backend running, no API key", "Set <code>GROQ_API_KEY</code> and restart it");
  } else {
    setStatus("ok", "Backend running");
  }
}

function videoIdFrom(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== "www.youtube.com") return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    return u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function setupOpenButton() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const button = el("open-chat");

  if (!tab || !videoIdFrom(tab.url || "")) {
    button.disabled = true;
    setNote("open-note", "Open a YouTube video to start chatting.");
    return;
  }

  button.disabled = false;
  button.addEventListener("click", async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
      window.close();
    } catch {
      // The tab was opened before the extension was installed or reloaded.
      setNote("open-note", "Reload the YouTube tab, then try again.", "error");
    }
  });
}

async function setupSettings() {
  const input = el("api-base");
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  input.value = apiBase;

  el("settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    let url;
    try {
      url = new URL(input.value.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      setNote("settings-note", "Enter a full http:// or https:// URL.", "error");
      return;
    }

    // localhost is covered by the manifest; any other host needs permission first.
    if (!LOCAL_HOSTS.has(url.hostname)) {
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) {
        setNote("settings-note", "Permission for that host was not granted.", "error");
        return;
      }
    }

    const value = url.origin + url.pathname.replace(/\/+$/, "");
    await chrome.storage.sync.set({ apiBase: value });
    input.value = value;
    setNote("settings-note", "Saved.");
    checkBackend();
  });
}

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === "toggle-chat");
  el("shortcut").textContent = toggle?.shortcut || "not set";
}

checkBackend();
setupOpenButton();
setupSettings();
showShortcut();
