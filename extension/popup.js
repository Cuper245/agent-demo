const statusBox = document.getElementById("status");

function send(type) {
  statusBox.textContent = "Working...";

  chrome.runtime.sendMessage({ type }, (response) => {
    if (chrome.runtime.lastError) {
      statusBox.textContent = "Chrome error: " + chrome.runtime.lastError.message;
      return;
    }

    if (!response || !response.ok) {
      statusBox.textContent = "Error: " + (response?.error || "unknown error");
      return;
    }

    statusBox.textContent = JSON.stringify(response.data || response, null, 2);
  });
}

document.getElementById("start").addEventListener("click", () => {
  send("START_RECORDING");
});

document.getElementById("stop").addEventListener("click", () => {
  send("STOP_RECORDING");
});

document.getElementById("play").addEventListener("click", () => {
  send("PLAY_AGENT");
});