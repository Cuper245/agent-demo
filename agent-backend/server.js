require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = 4000;

const EVENTS_FILE = path.join(__dirname, "events.json");
const WORKFLOW_FILE = path.join(__dirname, "workflow.json");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// --- Gemini learner ---

async function learnWithGemini(events) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const compactEvents = events.map((e) => {
    const item = {
      type: e.eventType,
      system: e.system,
      url: e.url,
    };
    if (e.selectedText) item.copiedText = e.selectedText;
    if (e.pastedText) item.pastedText = e.pastedText;
    if (e.inputValue) item.inputValue = e.inputValue;
    if (e.element) {
      item.element = {
        selector: e.element.selector,
        label:
          e.element.inputLabel ||
          e.element.tableHeader ||
          e.element.detailLabel ||
          null,
        placeholder: e.element.placeholder || null,
        dataField:
          e.element.dataField ||
          e.element.dataOriginField ||
          e.element.dataDestinationField ||
          null,
        text: e.element.text?.slice(0, 150) || null,
      };
    }
    return item;
  });

  const originUrl =
    events.find((e) => e.system === "origin")?.url ||
    "https://valmart-ecru.vercel.app/";
  const destinationUrl =
    events.find((e) => e.system === "destination")?.url ||
    "https://arco-nine.vercel.app/";

  const prompt = `You are an AI browser workflow learner.

A user performed actions in a browser. Analyze the recorded events and produce a reusable workflow JSON.

WORKFLOW TYPES:
1. "data_transfer" - User copied values from an "origin" system and pasted them into a "destination" system's form. Learn the field mappings so they can be automated for future rows.
2. "action_sequence" - User performed a sequence of actions on one or more pages (e.g. login, form fill, button clicks). Learn the step-by-step actions to replay.

Choose the type that best fits the events.

RECORDED EVENTS:
${JSON.stringify(compactEvents, null, 2)}

For "data_transfer", return exactly this JSON shape (fill in real values from events):
{
  "workflowType": "data_transfer",
  "workflowName": "database_row_transfer",
  "origin": {
    "url": "${originUrl}",
    "rowSelector": "#orders-body tr",
    "cellSelector": "td",
    "tableHeadersSelector": "#origin-orders-table thead th"
  },
  "destination": {
    "url": "${destinationUrl}",
    "formSelector": "#destination-form",
    "submitSelector": "#save-order",
    "resultRowsSelector": "#registered-body tr"
  },
  "mappings": [
    {
      "originLabel": "PO Number",
      "originField": "poNumber",
      "originSelector": "[data-field=\\"poNumber\\"]",
      "destinationLabel": "Internal Order ID",
      "destinationSelector": "#internal-order-id",
      "destinationField": "internalOrderId",
      "observedValue": "PO-1001",
      "reason": "Value PO-1001 was copied from PO Number and pasted into Internal Order ID",
      "confidence": 0.98
    }
  ]
}

For "action_sequence", return exactly this JSON shape (fill in real values from events):
{
  "workflowType": "action_sequence",
  "workflowName": "recorded_flow",
  "targetUrl": "https://example.com",
  "steps": [
    { "action": "navigate", "url": "https://example.com/login", "label": "Go to login" },
    { "action": "fill", "selector": "#email", "value": "user@example.com", "label": "Enter email" },
    { "action": "fill", "selector": "#password", "value": "secret", "label": "Enter password" },
    { "action": "click", "selector": "button[type=submit]", "label": "Submit" },
    { "action": "waitFor", "selector": ".dashboard", "label": "Wait for dashboard" }
  ],
  "variables": []
}

Rules:
- Return ONLY valid JSON. No explanation. No markdown code fences.
- For data_transfer: use semantic field matching, not just exact value matches. Infer originField from camelCase of the originLabel.
- For action_sequence: include all meaningful user interactions in order. Use the most stable selector available (id > data attribute > class).
- Set confidence to 0.9+ when you are certain, lower when guessing.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

// --- Heuristic learner (fallback) ---

function learnWithHeuristic(events) {
  const originEvents = events.filter((e) => e.system === "origin");
  const destinationEvents = events.filter((e) => e.system === "destination");

  const originUrl =
    originEvents[0]?.url || "https://valmart-ecru.vercel.app/";
  const destinationUrl =
    destinationEvents[0]?.url || "https://arco-nine.vercel.app/";

  const originObservations = [
    ...originEvents
      .filter((e) => e.eventType === "copy" && e.selectedText)
      .map((e) => ({
        value: e.selectedText.trim(),
        selector: e.element?.selector || null,
        originField:
          e.element?.dataField || e.element?.dataOriginField || null,
        originLabel:
          e.element?.detailLabel ||
          e.element?.tableHeader ||
          e.element?.dataField ||
          null,
      })),
    ...originEvents
      .filter((e) => e.eventType === "click" && e.element?.text)
      .map((e) => ({
        value: e.element.text.trim(),
        selector: e.element.selector,
        originField:
          e.element?.dataField || e.element?.dataOriginField || null,
        originLabel:
          e.element?.detailLabel ||
          e.element?.tableHeader ||
          e.element?.dataField ||
          null,
      })),
  ].filter((item) => item.value);

  const destinationWrites = destinationEvents
    .filter(
      (e) =>
        (e.eventType === "input" ||
          e.eventType === "change" ||
          e.eventType === "paste") &&
        (e.inputValue || e.pastedText)
    )
    .map((e) => ({
      value: (e.inputValue || e.pastedText || "").trim(),
      selector: e.element?.selector,
      label:
        e.element?.inputLabel ||
        e.element?.dataDestinationField ||
        e.element?.placeholder ||
        null,
      destinationField: e.element?.dataDestinationField || null,
    }))
    .filter((item) => item.value);

  const destByValue = new Map();
  for (const write of destinationWrites) {
    destByValue.set(write.value, write);
  }

  const seen = new Set();
  const mappings = [];

  for (const origin of originObservations) {
    const destination = destByValue.get(origin.value);
    if (!destination) continue;

    const key = `${origin.originField || origin.originLabel}->${destination.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);

    mappings.push({
      originLabel: origin.originLabel,
      originField: origin.originField,
      originSelector: origin.selector,
      destinationLabel: destination.label,
      destinationSelector: destination.selector,
      destinationField: destination.destinationField,
      observedValue: origin.value,
      confidence: 0.95,
    });
  }

  return {
    workflowType: "data_transfer",
    workflowName: "database_row_transfer",
    origin: {
      url: originUrl,
      rowSelector: "#orders-body tr",
      cellSelector: "td",
      tableHeadersSelector: "#origin-orders-table thead th",
    },
    destination: {
      url: destinationUrl,
      formSelector: "#destination-form",
      submitSelector: "#save-order",
      resultRowsSelector: "#registered-body tr",
    },
    mappings,
  };
}

// --- Routes ---

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Agent backend is running" });
});

app.post("/events", (req, res) => {
  const event = req.body;
  const events = readJson(EVENTS_FILE, []);
  events.push(event);
  writeJson(EVENTS_FILE, events);
  log(`Event: ${event.eventType} | ${event.system} | ${event.url}`);
  res.json({ ok: true, totalEvents: events.length });
});

app.get("/events", (req, res) => {
  res.json(readJson(EVENTS_FILE, []));
});

app.post("/reset", (req, res) => {
  writeJson(EVENTS_FILE, []);
  res.json({ ok: true, message: "Events reset" });
});

app.post("/learn", async (req, res) => {
  const events = readJson(EVENTS_FILE, []);

  if (events.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "No events recorded. Start recording first.",
    });
  }

  let workflow = null;
  let learner = "gemini";

  // Try Gemini first
  if (process.env.GEMINI_API_KEY) {
    try {
      log("Calling Gemini to learn workflow...");
      workflow = await learnWithGemini(events);

      if (!workflow || !workflow.workflowType) {
        throw new Error("Gemini returned invalid workflow");
      }

      // For data_transfer: require at least one mapping
      if (
        workflow.workflowType === "data_transfer" &&
        (!workflow.mappings || workflow.mappings.length === 0)
      ) {
        throw new Error("Gemini returned no mappings");
      }

      // For action_sequence: require at least one step
      if (
        workflow.workflowType === "action_sequence" &&
        (!workflow.steps || workflow.steps.length === 0)
      ) {
        throw new Error("Gemini returned no steps");
      }

      log(`Gemini learned workflow: ${workflow.workflowType} (${workflow.workflowName})`);
    } catch (err) {
      log(`Gemini failed: ${err.message} — falling back to heuristic`);
      workflow = null;
      learner = "heuristic";
    }
  }

  // Fall back to heuristic
  if (!workflow) {
    learner = "heuristic";
    workflow = learnWithHeuristic(events);

    if (
      workflow.workflowType === "data_transfer" &&
      workflow.mappings.length === 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "No mappings learned. The recorder did not capture matching origin and destination values.",
        debug: {
          totalEvents: events.length,
          originEvents: events.filter((e) => e.system === "origin").length,
          destinationEvents: events.filter((e) => e.system === "destination")
            .length,
        },
      });
    }
  }

  workflow.learnedBy = learner;
  workflow.learnedFromObservation = true;
  workflow.createdAt = new Date().toISOString();

  writeJson(WORKFLOW_FILE, workflow);
  log(`Workflow saved (learner: ${learner}).`);

  res.json({ ok: true, learner, workflow });
});

app.get("/workflow", (req, res) => {
  res.json(readJson(WORKFLOW_FILE, {}));
});

app.post("/play", (req, res) => {
  log("Starting Playwright execution...");

  const child = spawn("node", ["run-playwright.js"], {
    cwd: __dirname,
    shell: true,
  });

  child.stdout.on("data", (data) => {
    process.stdout.write(`[Playwright] ${data}`);
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(`[Playwright Error] ${data}`);
  });

  child.on("close", (code) => {
    log(`Playwright finished with code ${code}`);
  });

  res.json({ ok: true, message: "Playwright agent started" });
});

app.get("/debug-events", (req, res) => {
  const events = readJson(EVENTS_FILE, []);

  const summary = events.map((e) => ({
    eventType: e.eventType,
    system: e.system,
    url: e.url,
    selectedText: e.selectedText || null,
    inputValue: e.inputValue || null,
    pastedText: e.pastedText || null,
    elementText: e.element?.text || null,
    elementSelector: e.element?.selector || null,
    tableHeader: e.element?.tableHeader || null,
    detailLabel: e.element?.detailLabel || null,
    inputLabel: e.element?.inputLabel || null,
  }));

  res.json({
    totalEvents: events.length,
    originEvents: events.filter((e) => e.system === "origin").length,
    destinationEvents: events.filter((e) => e.system === "destination").length,
    unknownEvents: events.filter((e) => e.system === "unknown").length,
    summary,
  });
});

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
  log(`Gemini API: ${process.env.GEMINI_API_KEY ? "configured" : "NOT configured (heuristic only)"}`);
});
