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
  const title = document.title.toLowerCase();
  const heading = document.querySelector("h1")?.innerText?.toLowerCase() || "";
  const url = window.location.href.toLowerCase();

  if (
    url.includes("https://valmart-ecru.vercel.app/") ||
    title.includes("origin") ||
    heading.includes("origin") ||
    heading.includes("retailer")
  ) {
    return "origin";
  }

  if (
    url.includes("https://arco-nine.vercel.app/") ||
    title.includes("destination") ||
    heading.includes("destination") ||
    heading.includes("internal")
  ) {
    return "destination";
  }

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
    const isPassword = target.getAttribute("type") === "password";

    sendRecorderEvent({
      eventType: "input",
      element: getElementContext(target),
      inputValue: isPassword ? "[REDACTED_PASSWORD]" : target.value
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
    const target = event.target;
    const isPassword = target.getAttribute("type") === "password";
    const pastedText = event.clipboardData?.getData("text") || "";

    sendRecorderEvent({
      eventType: "paste",
      pastedText: isPassword ? "[REDACTED_PASSWORD]" : pastedText,
      element: getElementContext(target)
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