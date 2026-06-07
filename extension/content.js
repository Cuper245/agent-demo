function getSimpleSelector(element) {
  if (!element) return null;

  if (element.id) {
    return `#${element.id}`;
  }

  if (element.getAttribute("data-origin-field")) {
    return `[data-origin-field="${element.getAttribute("data-origin-field")}"]`;
  }

  if (element.getAttribute("data-destination-field")) {
    return `[data-destination-field="${element.getAttribute("data-destination-field")}"]`;
  }

  if (element.getAttribute("data-field")) {
    return `[data-field="${element.getAttribute("data-field")}"]`;
  }

  if (element.className && typeof element.className === "string") {
    const classes = element.className
      .split(" ")
      .filter(Boolean)
      .map((className) => `.${className}`)
      .join("");

    if (classes) {
      return `${element.tagName.toLowerCase()}${classes}`;
    }
  }

  const parent = element.parentElement;
  if (!parent) return element.tagName.toLowerCase();

  const index = Array.from(parent.children).indexOf(element) + 1;
  return `${getSimpleSelector(parent)} > ${element.tagName.toLowerCase()}:nth-child(${index})`;
}

function getLabelForInput(element) {
  if (!element || element.tagName.toLowerCase() !== "input") return null;

  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.innerText.trim();
  }

  return null;
}

function getTableHeaderForCell(element) {
  const cell = element.closest("td");
  if (!cell) return null;

  const row = cell.parentElement;
  const table = cell.closest("table");
  if (!row || !table) return null;

  const cellIndex = Array.from(row.children).indexOf(cell);
  const header = table.querySelectorAll("thead th")[cellIndex];

  return header ? header.innerText.trim() : null;
}

function getDetailLabel(element) {
  const detailRow = element.closest(".detail-row");
  if (!detailRow) return null;

  const label = detailRow.querySelector(".label");
  return label ? label.innerText.trim() : null;
}

function getElementContext(element) {
  const tag = element.tagName.toLowerCase();

  return {
    tag,
    id: element.id || null,
    className: element.className || null,
    selector: getSimpleSelector(element),
    text: element.innerText || element.textContent || null,
    value: element.value || null,
    placeholder: element.getAttribute("placeholder"),
    ariaLabel: element.getAttribute("aria-label"),
    name: element.getAttribute("name"),
    type: element.getAttribute("type"),
    dataField: element.getAttribute("data-field"),
    dataOriginField: element.getAttribute("data-origin-field"),
    dataDestinationField: element.getAttribute("data-destination-field"),
    inputLabel: getLabelForInput(element),
    tableHeader: getTableHeaderForCell(element),
    detailLabel: getDetailLabel(element),
    nearbyText: element.parentElement
      ? element.parentElement.innerText?.slice(0, 500)
      : null
  };
}

function getSystemType() {
  const hostname = window.location.hostname;

  // URL-based detection for known systems
  if (hostname.includes("valmart")) return "origin";
  if (hostname.includes("arco-nine")) return "destination";

  // Fallback: detect by page title or h1
  const title = document.title.toLowerCase();
  const heading = document.querySelector("h1")?.innerText?.toLowerCase() || "";

  if (title.includes("origin") || heading.includes("origin")) return "origin";
  if (title.includes("destination") || heading.includes("destination")) return "destination";

  return "unknown";
}

async function isRecording() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["isRecording"], (result) => {
      resolve(Boolean(result.isRecording));
    });
  });
}

async function sendRecorderEvent(eventData) {
  const recording = await isRecording();
  if (!recording) return;

  const payload = {
    ...eventData,
    system: getSystemType(),
    url: window.location.href,
    title: document.title,
    timestamp: new Date().toISOString()
  };

  chrome.runtime.sendMessage({
    type: "RECORDER_EVENT",
    payload
  });
}

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;

    sendRecorderEvent({
      eventType: "click",
      element: getElementContext(target)
    });
  },
  true
);

document.addEventListener(
  "input",
  (event) => {
    const target = event.target;

    sendRecorderEvent({
      eventType: "input",
      element: getElementContext(target),
      inputValue: target.value
    });
  },
  true
);

document.addEventListener(
  "change",
  (event) => {
    const target = event.target;

    sendRecorderEvent({
      eventType: "change",
      element: getElementContext(target),
      inputValue: target.value
    });
  },
  true
);

document.addEventListener(
  "copy",
  () => {
    const selectedText = window.getSelection()?.toString() || "";

    sendRecorderEvent({
      eventType: "copy",
      selectedText
    });
  },
  true
);

document.addEventListener(
  "paste",
  (event) => {
    const pastedText = event.clipboardData?.getData("text") || "";

    sendRecorderEvent({
      eventType: "paste",
      pastedText,
      element: getElementContext(event.target)
    });
  },
  true
);

document.addEventListener(
  "submit",
  (event) => {
    sendRecorderEvent({
      eventType: "submit",
      element: getElementContext(event.target)
    });
  },
  true
);

// Capture URL navigation changes (for SPA routing and login redirects)
let _lastUrl = window.location.href;
const _navObserver = new MutationObserver(() => {
  const current = window.location.href;
  if (current !== _lastUrl) {
    _lastUrl = current;
    sendRecorderEvent({ eventType: "navigate", navigatedTo: current });
  }
});
_navObserver.observe(document.documentElement, { subtree: true, childList: true });

// Send initial page load event so Gemini knows the starting URL
sendRecorderEvent({ eventType: "pageload", pageTitle: document.title });