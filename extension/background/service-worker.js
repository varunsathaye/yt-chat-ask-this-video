// Background service worker.
// - Proxies API calls from the content script to the local backend. Requests made here
//   use the extension's host permissions, so they avoid YouTube's CORS / private-network rules.
// - Relays the keyboard shortcut to the active tab.

const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 180_000; // the first ingest loads the embedding model, which can be slow

async function getApiBase() {
  const { apiBase } = await chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE });
  return apiBase.replace(/\/+$/, "");
}

async function callApi({ path, method = "GET", body }) {
  const base = await getApiBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.detail || `Request failed (${res.status})` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const error =
      err.name === "AbortError"
        ? "The backend took too long to answer."
        : `Can't reach the backend at ${base}. Is it running?`;
    return { ok: false, status: 0, error };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "api") {
    callApi(msg).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-chat") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
});
