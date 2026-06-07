const BACKEND_URL = "http://localhost:4000";

function captureScreenshot(windowId, meta) {
  chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) return;
    fetch(`${BACKEND_URL}/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenshot: dataUrl, ...meta })
    }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORDER_EVENT") {
    const payload = message.payload;

    fetch(`${BACKEND_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        console.error("Failed to send event:", error);
        sendResponse({ ok: false, error: String(error) });
      });

    // Capture screenshot on submit or first pageload — key moments for Computer Use context
    const captureOn = ["submit", "pageload", "navigate"];
    if (captureOn.includes(payload.eventType) && sender.tab?.windowId) {
      captureScreenshot(sender.tab.windowId, {
        triggerEvent: payload.eventType,
        system: payload.system,
        url: payload.url,
        timestamp: payload.timestamp
      });
    }

    return true;
  }

  if (message.type === "START_RECORDING") {
    chrome.storage.local.set({ isRecording: true }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    chrome.storage.local.set({ isRecording: false }, () => {
      fetch(`${BACKEND_URL}/learn`, { method: "POST" })
        .then((res) => res.json())
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
    });
    return true;
  }

  if (message.type === "PLAY_AGENT") {
    fetch(`${BACKEND_URL}/play`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});
