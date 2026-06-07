const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const WORKFLOW_FILE = path.join(__dirname, "workflow.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function labelToKey(label) {
  const dictionary = {
    "PO Number": "poNumber",
    "Customer": "customer",
    "Store ID": "storeId",
    "SKU": "sku",
    "Units": "units",
    "Delivery Date": "deliveryDate",
    "Notes": "notes"
  };

  return dictionary[label] || null;
}

async function extractOriginRows(originPage, workflow) {
  const headers = await originPage
    .locator(workflow.origin.tableHeadersSelector)
    .allInnerTexts();

  const rowCount = await originPage.locator(workflow.origin.rowSelector).count();

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

      if (header) {
        rowObject[header] = value;
      }

      if (dataField) {
        rowObject[dataField] = value;
      }
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

async function main() {
  const workflow = readJson(WORKFLOW_FILE);

  console.log("Loaded workflow:");
  console.log(JSON.stringify(workflow, null, 2));

  if (!workflow.mappings || workflow.mappings.length === 0) {
    throw new Error("No mappings found. Record one manual transfer first.");
  }

  const userDataDir = path.join(__dirname, "playwright-profile");

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 350,
    viewport: {
      width: 1200,
      height: 850
    }
  });

  const pages = context.pages();

  const originPage = pages.length > 0 ? pages[0] : await context.newPage();
  const destinationPage = await context.newPage();

  console.log("Opening origin...");
  await originPage.goto(workflow.origin.url, {
    waitUntil: "domcontentloaded"
  });

  console.log("Opening destination...");
  await destinationPage.goto(workflow.destination.url, {
    waitUntil: "domcontentloaded"
  });

  /* console.log("Clearing destination for clean demo...");
  await destinationPage.evaluate(() => {
    localStorage.removeItem("destination_orders");
  });

  await destinationPage.goto(workflow.destination.url, {
    waitUntil: "domcontentloaded"
  }); */

  console.log("Extracting origin rows...");
  const originRows = await extractOriginRows(originPage, workflow);

  console.log("Origin rows:");
  console.log(JSON.stringify(originRows, null, 2));

  const existingDestinationIds = await getDestinationOrderIds(destinationPage);
  console.log("Existing destination order IDs:");
  console.log(existingDestinationIds);

  const rowsToTransfer = originRows.filter((row) => {
    const poNumber = row["PO Number"] || row["poNumber"];
    return poNumber && !existingDestinationIds.includes(poNumber);
    });

  console.log("Rows to transfer:");
  console.log(JSON.stringify(rowsToTransfer, null, 2));

  for (const row of rowsToTransfer) {
    console.log(`Transferring order: ${row["PO Number"]}`);

    for (const mapping of workflow.mappings) {
      const originLabel = mapping.originLabel;
      const originField = mapping.originField;
      const destinationSelector = mapping.destinationSelector;

      if (!originLabel || !destinationSelector) {
        console.log("Skipping incomplete mapping:");
        console.log(mapping);
        continue;
      }

      const value =
        row[originField] ||
        row[originLabel] ||
        "";

      if (!value) {
        console.log(`WARNING: No value found for mapping ${originLabel} / ${originField}`);
        }  

      console.log(`${originLabel} → ${mapping.destinationLabel}: ${value}`);

      const input = destinationPage.locator(destinationSelector);

      await input.waitFor({
        state: "visible",
        timeout: 10000
      });

      await input.click();
      await input.fill(value);
    }

    await destinationPage.locator(workflow.destination.submitSelector).click();
    await destinationPage.waitForTimeout(700);
  }

  const finalIds = await getDestinationOrderIds(destinationPage);

  console.log("Final destination order IDs:");
  console.log(finalIds);

  console.log("Validation:");
  for (const row of rowsToTransfer) {
    const po = row["PO Number"];
    const exists = finalIds.includes(po);
    console.log(`${exists ? "PASS" : "FAIL"} - ${po}`);
  }

  console.log("Agent execution finished.");

  await destinationPage.waitForTimeout(10000);
  await context.close();
}

main().catch((error) => {
  console.error("Agent failed:", error);
  process.exit(1);
});