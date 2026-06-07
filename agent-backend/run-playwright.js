const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const WORKFLOW_FILE = path.join(__dirname, "workflow.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// --- Action sequence executor (for login / generic flows) ---

async function executeActionSequence(page, workflow) {
  const { steps = [], workflowName } = workflow;

  console.log(`\nExecuting action sequence: ${workflowName}`);
  console.log(`Steps: ${steps.length}`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = step.label || `${step.action} ${step.selector || step.url || ""}`;
    console.log(`  [${i + 1}/${steps.length}] ${label}`);

    try {
      switch (step.action) {
        case "navigate":
          await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
          break;

        case "fill":
          await page.locator(step.selector).waitFor({ state: "visible", timeout: 10000 });
          await page.locator(step.selector).fill(step.value || "");
          break;

        case "click":
          await page.locator(step.selector).waitFor({ state: "visible", timeout: 10000 });
          await page.locator(step.selector).click();
          break;

        case "select":
          await page.locator(step.selector).selectOption(step.value || "");
          break;

        case "waitFor":
          await page
            .locator(step.selector)
            .waitFor({ state: "visible", timeout: step.timeout || 10000 });
          break;

        case "waitForNavigation":
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
          break;

        case "scroll":
          await page.locator(step.selector || "body").scrollIntoViewIfNeeded();
          break;

        default:
          console.log(`    (unknown action: ${step.action}, skipping)`);
      }

      await page.waitForTimeout(400);
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message}`);
    }
  }

  console.log("\nAction sequence completed.");
}

// --- Data transfer executor (origin → destination form fill) ---

async function extractOriginRows(originPage, workflow) {
  const headers = await originPage
    .locator(workflow.origin.tableHeadersSelector)
    .allInnerTexts();

  const rowCount = await originPage
    .locator(workflow.origin.rowSelector)
    .count();

  const rows = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = originPage.locator(workflow.origin.rowSelector).nth(rowIndex);
    const cells = row.locator(workflow.origin.cellSelector);
    const cellCount = await cells.count();

    const rowObject = {};

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const cell = cells.nth(cellIndex);
      const value = (await cell.innerText()).trim();
      const header = headers[cellIndex]?.trim();
      const dataField = await cell.getAttribute("data-field");

      if (header) rowObject[header] = value;
      if (dataField) rowObject[dataField] = value;
    }

    rows.push(rowObject);
  }

  return rows;
}

async function getDestinationOrderIds(destinationPage) {
  const ids = await destinationPage
    .locator('#registered-body tr td[data-field="internalOrderId"]')
    .allInnerTexts()
    .catch(() => []);

  return ids.map((id) => id.trim()).filter(Boolean);
}

async function executeDataTransfer(context, workflow) {
  const pages = context.pages();
  const originPage = pages.length > 0 ? pages[0] : await context.newPage();
  const destinationPage = await context.newPage();

  console.log("Opening origin...");
  await originPage.goto(workflow.origin.url, { waitUntil: "domcontentloaded" });

  console.log("Opening destination...");
  await destinationPage.goto(workflow.destination.url, { waitUntil: "domcontentloaded" });

  console.log("Extracting origin rows...");
  const originRows = await extractOriginRows(originPage, workflow);
  console.log(`Found ${originRows.length} origin rows`);

  const existingIds = await getDestinationOrderIds(destinationPage);
  console.log("Existing destination order IDs:", existingIds);

  const rowsToTransfer = originRows.filter((row) => {
    const poNumber = row["PO Number"] || row["poNumber"];
    return poNumber && !existingIds.includes(poNumber);
  });

  console.log(`Rows to transfer: ${rowsToTransfer.length}`);

  for (const row of rowsToTransfer) {
    const poNumber = row["PO Number"] || row["poNumber"];
    console.log(`\nTransferring: ${poNumber}`);

    for (const mapping of workflow.mappings) {
      const { originLabel, originField, destinationSelector, destinationLabel } = mapping;

      if (!destinationSelector) continue;

      const value = row[originField] || row[originLabel] || "";

      if (!value) {
        console.log(`  WARNING: no value for ${originLabel || originField}`);
        continue;
      }

      console.log(`  ${originLabel || originField} → ${destinationLabel}: ${value}`);

      const input = destinationPage.locator(destinationSelector);
      await input.waitFor({ state: "visible", timeout: 10000 });
      await input.click();
      await input.fill(value);
    }

    await destinationPage.locator(workflow.destination.submitSelector).click();
    await destinationPage.waitForTimeout(700);
  }

  const finalIds = await getDestinationOrderIds(destinationPage);
  console.log("\nValidation:");
  for (const row of rowsToTransfer) {
    const po = row["PO Number"] || row["poNumber"];
    console.log(`  ${finalIds.includes(po) ? "PASS" : "FAIL"} - ${po}`);
  }
}

// --- Main ---

async function main() {
  const workflow = readJson(WORKFLOW_FILE);
  const workflowType = workflow.workflowType || "data_transfer";

  console.log(`Workflow: ${workflow.workflowName} (type: ${workflowType})`);
  console.log(`Learned by: ${workflow.learnedBy || "heuristic"}`);

  const userDataDir = path.join(__dirname, "playwright-profile");

  if (workflowType === "action_sequence") {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      slowMo: 400,
      viewport: { width: 1280, height: 900 },
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Navigate to the target URL first if provided and no navigate step leads the sequence
    const firstStep = workflow.steps?.[0];
    const startsWithNavigate = firstStep?.action === "navigate";

    if (!startsWithNavigate && workflow.targetUrl) {
      await page.goto(workflow.targetUrl, { waitUntil: "domcontentloaded" });
    }

    await executeActionSequence(page, workflow);

    await page.waitForTimeout(5000);
    await context.close();
  } else {
    if (!workflow.mappings || workflow.mappings.length === 0) {
      throw new Error("No mappings found. Record one manual transfer first.");
    }

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      slowMo: 350,
      viewport: { width: 1200, height: 850 },
    });

    await executeDataTransfer(context, workflow);

    console.log("\nAgent execution finished.");
    await context.pages()[0]?.waitForTimeout(8000);
    await context.close();
  }
}

main().catch((error) => {
  console.error("Agent failed:", error);
  process.exit(1);
});
