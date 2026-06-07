const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = 4000;

const EVENTS_FILE = path.join(__dirname, "events.json");
const WORKFLOW_FILE = path.join(__dirname, "workflow.json");

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function log(message) {
  console.log(`[Agent Backend] ${message}`);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Agent backend is running"
  });
});

app.post("/events", (req, res) => {
  const event = req.body;
  const events = readJson(EVENTS_FILE, []);

  events.push(event);
  writeJson(EVENTS_FILE, events);

  log(`Event received: ${event.eventType} | ${event.system} | ${event.url}`);

  res.json({
    ok: true,
    totalEvents: events.length
  });
});

app.get("/events", (req, res) => {
  const events = readJson(EVENTS_FILE, []);
  res.json(events);
});

app.post("/reset", (req, res) => {
  writeJson(EVENTS_FILE, []);
  res.json({
    ok: true,
    message: "Events reset"
  });
});

app.get("/debug-events", (req, res) => {
  const events = readJson(EVENTS_FILE, []);

  const summary = events.map((event) => ({
    eventType: event.eventType,
    system: event.system,
    selectedText: event.selectedText || null,
    inputValue: event.inputValue || null,
    pastedText: event.pastedText || null,
    elementText: event.element?.text || null,
    elementSelector: event.element?.selector || null,
    tableHeader: event.element?.tableHeader || null,
    detailLabel: event.element?.detailLabel || null,
    inputLabel: event.element?.inputLabel || null
  }));

  res.json({
    totalEvents: events.length,
    originEvents: events.filter((e) => e.system === "origin").length,
    destinationEvents: events.filter((e) => e.system === "destination").length,
    summary
  });
});

app.post("/learn", (req, res) => {
  const events = readJson(EVENTS_FILE, []);

  const originEvents = events.filter((event) => event.system === "origin");
  const destinationEvents = events.filter((event) => event.system === "destination");

  const originUrl = originEvents[0]?.url || "http://localhost:3000";
  const destinationUrl = destinationEvents[0]?.url || "http://localhost:3001";

  const copiedValues = originEvents
    .filter((event) => event.eventType === "copy" && event.selectedText)
    .map((event) => event.selectedText.trim())
    .filter(Boolean);

  const originClicks = originEvents
    .filter((event) => event.eventType === "click" && event.element?.text)
    .map((event) => ({
      value: event.element.text.trim(),
      selector: event.element.selector,
      label:
        event.element.detailLabel ||
        event.element.tableHeader ||
        event.element.dataField ||
        event.element.dataOriginField ||
        null
    }))
    .filter((item) => item.value);

  const destinationWrites = destinationEvents
    .filter(
      (event) =>
        (event.eventType === "input" ||
          event.eventType === "change" ||
          event.eventType === "paste") &&
        (event.inputValue || event.pastedText)
    )
    .map((event) => ({
      value: (event.inputValue || event.pastedText || "").trim(),
      selector: event.element?.selector,
      label:
        event.element?.inputLabel ||
        event.element?.dataDestinationField ||
        event.element?.placeholder ||
        null,
      destinationField: event.element?.dataDestinationField || null
    }))
    .filter((item) => item.value);

  const finalDestinationWritesByValue = new Map();

  for (const write of destinationWrites) {
    finalDestinationWritesByValue.set(write.value, write);
  }

  const mappings = [];

  for (const origin of originClicks) {
    const destination = finalDestinationWritesByValue.get(origin.value);

    if (destination) {
      mappings.push({
        originLabel: origin.label,
        originSelector: origin.selector,
        destinationLabel: destination.label,
        destinationSelector: destination.selector,
        destinationField: destination.destinationField,
        observedValue: origin.value,
        confidence: 0.95
      });
    }
  }

  const uniqueMappings = [];
  const seen = new Set();

  for (const mapping of mappings) {
    const key = `${mapping.originLabel}->${mapping.destinationSelector}`;

    if (!seen.has(key)) {
      seen.add(key);
      uniqueMappings.push(mapping);
    }
  }

  if (uniqueMappings.length === 0) {
    return res.status(400).json({
        ok: false,
        error: "No mappings learned. The recorder did not capture matching origin and destination values.",
        debug: {
        totalEvents: events.length,
        originEvents: originEvents.length,
        destinationEvents: destinationEvents.length,
        copiedValues,
        destinationWrites,
        originObservations
        }
    });
    }

  const workflow = {
    workflowName: "database_row_transfer",
    origin: {
      url: originUrl,
      rowSelector: "#orders-body tr",
      cellSelector: "td",
      tableHeadersSelector: "#origin-orders-table thead th"
    },
    destination: {
      url: destinationUrl,
      formSelector: "#destination-form",
      submitSelector: "#save-order",
      resultRowsSelector: "#registered-body tr"
    },
    mappings: uniqueMappings,
    learnedFromObservation: true,
    observedCopiedValues: copiedValues,
    explanation:
      "The recorder observed which origin cell values were copied or clicked and which destination form inputs received the same values. It inferred column-to-field mappings from matching values, labels, and selectors.",
    confidence: uniqueMappings.length > 0 ? 0.95 : 0.45,
    createdAt: new Date().toISOString()
  };

  writeJson(WORKFLOW_FILE, workflow);

  log("Database-style workflow learned and saved.");

  res.json({
    ok: true,
    workflow
  });
});

function generalizeDestinationListSelector(inputSelector) {
    // For this TodoMVC prototype, destination list is near the input.
    // Later, this should also be learned from DOM context or LLM.
    return "#destination-list li label";
    }

app.post("/learn-todos", (req, res) => {

    const firstOriginClick = originEvents.find(
    (event) =>
        event.eventType === "click" &&
        event.element?.text &&
        event.element?.selector
    );

    const firstDestinationWrite = destinationEvents.find(
    (event) =>
        (event.eventType === "enter" || event.eventType === "paste") &&
        event.element?.selector
    );

    const learnedOriginSelector = generalizeOriginSelector(
    firstOriginClick?.element?.selector
    );

    const learnedDestinationInputSelector =
    firstDestinationWrite?.element?.selector || ".new-todo";

    const learnedDestinationListSelector =
    generalizeDestinationListSelector(learnedDestinationInputSelector);

    const workflow = {
    workflowName: "copy_todos_from_origin_to_destination",
    origin: {
        url: originUrl,
        listSelector: learnedOriginSelector
    },
    destination: {
        url: destinationUrl,
        inputSelector: learnedDestinationInputSelector,
        listSelector: learnedDestinationListSelector
    },
    mapping: {
        "origin.todoText": "destination.newTodoInput"
    },
    learnedFromObservation: true,
    observedOriginTexts: originLabelsClicked,
    observedDestinationInputs: transferredValues,
    learnedSelectors: {
        originClickedSelector: firstOriginClick?.element?.selector || null,
        originGeneralizedSelector: learnedOriginSelector,
        destinationInputSelector: learnedDestinationInputSelector,
        destinationListSelector: learnedDestinationListSelector
    },
    explanation:
        "The recorder observed text selected/clicked in the origin system and matching values typed or pasted into the destination input. It inferred that origin list item text maps to the destination input field.",
    confidence: transferredValues.length > 0 ? 0.95 : 0.55,
    createdAt: new Date().toISOString()
    };

  writeJson(WORKFLOW_FILE, workflow);

  log("Workflow learned and saved.");

  res.json({
    ok: true,
    workflow
  });
});

app.get("/workflow", (req, res) => {
  const workflow = readJson(WORKFLOW_FILE, {});
  res.json(workflow);
});

app.post("/play", (req, res) => {
  log("Starting Playwright execution...");

  const child = spawn("node", ["run-playwright.js"], {
    cwd: __dirname,
    shell: true
  });

  child.stdout.on("data", (data) => {
    process.stdout.write(`[Playwright] ${data}`);
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(`[Playwright Error] ${data}`);
  });

  child.on("close", (code) => {
    log(`Playwright process finished with code ${code}`);
  });

  res.json({
    ok: true,
    message: "Playwright agent started"
  });
});

app.get("/debug-events", (req, res) => {
  const events = readJson(EVENTS_FILE, []);

  const summary = events.map((event) => ({
    eventType: event.eventType,
    system: event.system,
    url: event.url,
    selectedText: event.selectedText || null,
    inputValue: event.inputValue || null,
    pastedText: event.pastedText || null,
    elementText: event.element?.text || null,
    elementSelector: event.element?.selector || null,
    tableHeader: event.element?.tableHeader || null,
    detailLabel: event.element?.detailLabel || null,
    inputLabel: event.element?.inputLabel || null
  }));

  res.json({
    totalEvents: events.length,
    originEvents: events.filter((e) => e.system === "origin").length,
    destinationEvents: events.filter((e) => e.system === "destination").length,
    unknownEvents: events.filter((e) => e.system === "unknown").length,
    summary
  });
});

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
});