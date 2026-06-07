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
const SCREENSHOTS_FILE = path.join(__dirname, "screenshots.json");
const WORKFLOW_FILE = path.join(__dirname, "workflow.json");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(cors());
app.use(express.json({ limit: "10mb" }));

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function log(message) {
  console.log(`[Agent Backend] ${message}`);
}

// --- Gemini learner (with vision) ---

async function learnWithGemini(events, screenshots) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const compactEvents = events.map((e) => {
    const item = { type: e.eventType, system: e.system, url: e.url };
    if (e.selectedText) item.copiedText = e.selectedText;
    if (e.pastedText) item.pastedText = e.pastedText;
    if (e.inputValue) item.inputValue = e.inputValue;
    if (e.element) {
      item.element = {
        selector: e.element.selector,
        label: e.element.inputLabel || e.element.tableHeader || e.element.detailLabel || null,
        placeholder: e.element.placeholder || null,
        dataField: e.element.dataField || e.element.dataOriginField || e.element.dataDestinationField || null,
        text: e.element.text?.slice(0, 150) || null,
      };
    }
    return item;
  });

  const originUrl = events.find((e) => e.system === "origin")?.url || "https://valmart-ecru.vercel.app/";
  const destinationUrl = events.find((e) => e.system === "destination")?.url || "https://arco-nine.vercel.app/";

  const promptText = `You are an AI browser workflow analyst.

A user manually performed a task in a browser. You have their recorded events and screenshots.

Analyze what the user did and produce a workflow JSON so an AI agent can replay it autonomously.

RECORDED EVENTS (compact):
${JSON.stringify(compactEvents, null, 2)}

Origin URL: ${originUrl}
Destination URL: ${destinationUrl}

Return this EXACT JSON shape (no markdown, no explanation):
{
  "workflowType": "computer_use",
  "workflowName": "recorded_workflow",
  "originUrl": "${originUrl}",
  "destinationUrl": "${destinationUrl}",
  "taskDescription": "A clear, complete instruction for an AI agent that will see a browser screen and must replay this exact workflow. Include: what site to start on, what actions to take, what data to transfer and how (which fields map to which), how to know when the task is done. Be specific and actionable.",
  "fieldMappings": "Brief summary of origin→destination field mappings observed, e.g. PO Number→Internal Order ID, Customer→Client Chain"
}`;

  // Build multimodal parts: text prompt + up to 3 screenshots
  const parts = [{ text: promptText }];
  for (const ss of screenshots.slice(0, 3)) {
    const base64 = ss.screenshot.replace(/^data:image\/\w+;base64,/, "");
    parts.push({ inlineData: { data: base64, mimeType: "image/png" } });
  }

  const result = await model.generateContent(parts);
  const text = result.response.text().trim();

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  return JSON.parse(cleaned);
}

// --- Heuristic learner (fallback, produces data_transfer workflow) ---

function learnWithHeuristic(events) {
  const originEvents = events.filter((e) => e.system === "origin");
  const destinationEvents = events.filter((e) => e.system === "destination");

  const originUrl = originEvents[0]?.url || "https://valmart-ecru.vercel.app/";
  const destinationUrl = destinationEvents[0]?.url || "https://arco-nine.vercel.app/";

  const originObservations = [
    ...originEvents
      .filter((e) => e.eventType === "copy" && e.selectedText)
      .map((e) => ({
        value: e.selectedText.trim(),
        selector: e.element?.selector || null,
        originField: e.element?.dataField || e.element?.dataOriginField || null,
        originLabel: e.element?.detailLabel || e.element?.tableHeader || e.element?.dataField || null,
      })),
    ...originEvents
      .filter((e) => e.eventType === "click" && e.element?.text)
      .map((e) => ({
        value: e.element.text.trim(),
        selector: e.element.selector,
        originField: e.element?.dataField || e.element?.dataOriginField || null,
        originLabel: e.element?.detailLabel || e.element?.tableHeader || e.element?.dataField || null,
      })),
  ].filter((item) => item.value);

  const destinationWrites = destinationEvents
    .filter(
      (e) =>
        (e.eventType === "input" || e.eventType === "change" || e.eventType === "paste") &&
        (e.inputValue || e.pastedText)
    )
    .map((e) => ({
      value: (e.inputValue || e.pastedText || "").trim(),
      selector: e.element?.selector,
      label: e.element?.inputLabel || e.element?.dataDestinationField || e.element?.placeholder || null,
      destinationField: e.element?.dataDestinationField || null,
    }))
    .filter((item) => item.value);

  const destByValue = new Map();
  for (const write of destinationWrites) destByValue.set(write.value, write);

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

app.post("/screenshot", (req, res) => {
  const { screenshot, triggerEvent, system, url, timestamp } = req.body;
  const screenshots = readJson(SCREENSHOTS_FILE, []);
  // Keep max 10 screenshots to avoid huge files
  if (screenshots.length < 10) {
    screenshots.push({ screenshot, triggerEvent, system, url, timestamp });
    writeJson(SCREENSHOTS_FILE, screenshots);
  }
  log(`Screenshot saved: ${triggerEvent} | ${system} | total: ${screenshots.length}`);
  res.json({ ok: true, total: screenshots.length });
});

app.post("/reset", (req, res) => {
  writeJson(EVENTS_FILE, []);
  writeJson(SCREENSHOTS_FILE, []);
  res.json({ ok: true, message: "Events and screenshots reset" });
});

app.post("/learn", async (req, res) => {
  const events = readJson(EVENTS_FILE, []);
  const screenshots = readJson(SCREENSHOTS_FILE, []);

  if (events.length === 0) {
    return res.status(400).json({ ok: false, error: "No events recorded. Start recording first." });
  }

  let workflow = null;
  let learner = "gemini";

  if (process.env.GEMINI_API_KEY) {
    try {
      log(`Calling Gemini to learn workflow... (${events.length} events, ${screenshots.length} screenshots)`);
      workflow = await learnWithGemini(events, screenshots);

      if (!workflow || !workflow.workflowType || !workflow.taskDescription) {
        throw new Error("Gemini returned invalid workflow");
      }

      log(`Gemini learned: ${workflow.workflowType} — "${workflow.taskDescription.slice(0, 80)}..."`);
    } catch (err) {
      log(`Gemini failed: ${err.message} — falling back to heuristic`);
      workflow = null;
      learner = "heuristic";
    }
  }

  if (!workflow) {
    learner = "heuristic";
    workflow = learnWithHeuristic(events);

    if (workflow.workflowType === "data_transfer" && workflow.mappings.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No mappings learned. Make sure to copy values from origin and paste into destination.",
        debug: {
          totalEvents: events.length,
          originEvents: events.filter((e) => e.system === "origin").length,
          destinationEvents: events.filter((e) => e.system === "destination").length,
        },
      });
    }
  }

  workflow.learnedBy = learner;
  workflow.learnedFromObservation = true;
  workflow.screenshotsCaptured = screenshots.length;
  workflow.createdAt = new Date().toISOString();

  writeJson(WORKFLOW_FILE, workflow);
  log(`Workflow saved (learner: ${learner}, type: ${workflow.workflowType}).`);

  res.json({ ok: true, learner, workflow });
});

app.get("/workflow", (req, res) => {
  res.json(readJson(WORKFLOW_FILE, {}));
});

app.post("/play", (req, res) => {
  const workflow = readJson(WORKFLOW_FILE, {});
  const workflowType = workflow.workflowType || "data_transfer";

  log(`Starting agent (type: ${workflowType})...`);

  let child;

  if (workflowType === "computer_use") {
    child = spawn("/usr/bin/python3", ["run-computer-use.py"], { cwd: __dirname, shell: false });
  } else {
    child = spawn("node", ["run-playwright.js"], { cwd: __dirname, shell: true });
  }

  child.stdout.on("data", (data) => process.stdout.write(`[Agent] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[Agent Error] ${data}`));
  child.on("close", (code) => log(`Agent finished with code ${code}`));

  res.json({ ok: true, message: `Agent started (${workflowType})` });
});

app.get("/logs", (req, res) => {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) return res.json({ runs: [] });

  const runs = fs.readdirSync(logsDir)
    .filter((name) => fs.statSync(path.join(logsDir, name)).isDirectory())
    .sort()
    .reverse()
    .map((runId) => {
      const runFile = path.join(logsDir, runId, "run.json");
      if (!fs.existsSync(runFile)) return { runId, status: "incomplete" };
      const run = readJson(runFile, {});
      return {
        runId,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        workflow: run.workflow?.name,
        turns: run.turns?.length || 0,
        summary: run.summary?.slice(0, 120),
      };
    });

  res.json({ runs });
});

app.get("/logs/:runId", (req, res) => {
  const runFile = path.join(__dirname, "logs", req.params.runId, "run.json");
  if (!fs.existsSync(runFile)) return res.status(404).json({ error: "Run not found" });
  res.json(readJson(runFile, {}));
});

app.get("/debug-events", (req, res) => {
  const events = readJson(EVENTS_FILE, []);
  const screenshots = readJson(SCREENSHOTS_FILE, []);

  const summary = events.map((e) => ({
    eventType: e.eventType,
    system: e.system,
    url: e.url,
    selectedText: e.selectedText || null,
    inputValue: e.inputValue || null,
    pastedText: e.pastedText || null,
    elementSelector: e.element?.selector || null,
    tableHeader: e.element?.tableHeader || null,
    inputLabel: e.element?.inputLabel || null,
  }));

  res.json({
    totalEvents: events.length,
    originEvents: events.filter((e) => e.system === "origin").length,
    destinationEvents: events.filter((e) => e.system === "destination").length,
    unknownEvents: events.filter((e) => e.system === "unknown").length,
    screenshotsCaptured: screenshots.length,
    summary,
  });
});

app.listen(PORT, () => {
  log(`Server running at http://localhost:${PORT}`);
  log(`Gemini API: ${process.env.GEMINI_API_KEY ? "configured ✓" : "NOT configured"}`);
});
