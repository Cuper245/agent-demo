const BACKEND_URL = "http://localhost:4000";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORDER_EVENT") {
    fetch(`${BACKEND_URL}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message.payload)
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        console.error("Failed to send event:", error);
        sendResponse({ ok: false, error: String(error) });
      });

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
      fetch(`${BACKEND_URL}/learn`, {
        method: "POST"
      })
        .then((res) => res.json())
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
    });
    return true;
  }

  if (message.type === "PLAY_AGENT") {
    fetch(`${BACKEND_URL}/play`, {
      method: "POST"
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));

    return true;
  }
});