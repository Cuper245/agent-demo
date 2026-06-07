require("dotenv").config();
const { decideRowsToTransferWithGemini } = require("./llm-decider");
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

async function extractDestinationRows(destinationPage) {
  const rows = [];

  const rowLocator = destinationPage.locator("tbody tr");
  const rowCount = await rowLocator.count().catch(() => 0);

  for (let i = 0; i < rowCount; i++) {
    const row = rowLocator.nth(i);
    const cells = await row.locator("td").allInnerTexts().catch(() => []);

    rows.push({
      rowIndex: i,
      rawText: cells.join(" | "),
      cells: cells.map((value) => value.trim())
    });
  }

  return rows;
}

async function loginIfNeeded(page, systemName) {
  const username = process.env.DEMO_USERNAME;
  const password = process.env.DEMO_PASSWORD;

  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i], input[placeholder*="user" i]'
  ).first();

  const passwordInput = page.locator(
    'input[type="password"], input[name="password"], input[placeholder*="password" i]'
  ).first();

  const hasLogin =
    (await emailInput.count()) > 0 &&
    (await passwordInput.count()) > 0;

  if (!hasLogin) {
    console.log(`${systemName}: already logged in or no login form detected.`);
    return;
  }

  console.log(`${systemName}: login form detected. Logging in...`);

  await emailInput.fill(username);
  await passwordInput.fill(password);

  const submitButton = page.locator(
    'button[type="submit"], button:has-text("Login"), button:has-text("Sign in"), button:has-text("Ingresar")'
  ).first();

  await submitButton.click();

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  console.log(`${systemName}: login completed.`);
}

async function getHeaders(originPage, workflow) {
  let headers = [];

  // First try Gemini's learned selector.
  try {
    headers = await originPage
      .locator(workflow.origin.tableHeadersSelector)
      .allInnerTexts();
  } catch {}

  headers = headers.map((h) => h.trim()).filter(Boolean);

  // Fallback to generic table headers.
  if (headers.length === 0) {
    try {
      headers = await originPage
        .locator("thead th")
        .allInnerTexts();
    } catch {}

    headers = headers.map((h) => h.trim()).filter(Boolean);
  }

  return headers;
}

async function extractOriginRows(originPage, workflow) {
  const rows = [];

  const headers = await getHeaders(originPage, workflow);

  console.log("Detected origin headers:");
  console.log(headers);

  const rowLocator = originPage.locator(workflow.origin.rowSelector);
  const rowCount = await rowLocator.count();

  console.log("Origin row count:", rowCount);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = rowLocator.nth(rowIndex);
    const rowObject = {
      __rowIndex: rowIndex
    };

    // Method 1: extract by table headers + td cells.
    const cells = row.locator(workflow.origin.cellSelector || "td");
    const cellCount = await cells.count();

    console.log(`Row ${rowIndex} cell count:`, cellCount);

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
      const cell = cells.nth(cellIndex);
      const value = (await cell.innerText().catch(() => "")).trim();

      const header = headers[cellIndex];

      if (header && value) {
        rowObject[header] = value;
      }

      // Also store generic column keys for debugging.
      if (value) {
        rowObject[`COL_${cellIndex}`] = value;
      }
    }

    // Method 2: extract using Gemini-learned origin selectors.
    for (const mapping of workflow.mappings || []) {
      if (!mapping.originLabel || !mapping.originSelector) continue;

      const value = await row
        .locator(mapping.originSelector)
        .first()
        .innerText()
        .catch(async () => {
          // Fallback: try globally if relative selector fails.
          return await originPage
            .locator(mapping.originSelector)
            .nth(rowIndex)
            .innerText()
            .catch(() => "");
        });

      const cleanValue = String(value || "").trim();

      if (cleanValue) {
        rowObject[mapping.originLabel] = cleanValue;

        if (mapping.originField) {
          rowObject[mapping.originField] = cleanValue;
        }
      }
    }

    // Method 3: keep raw row text so Gemini can reason even if structured extraction is imperfect.
    rowObject.__rawText = await row.innerText().catch(() => "");

    rows.push(rowObject);
  }

  return rows;
}

async function ensureOriginOrdersPage(originPage, workflow) {
  console.log("Ensuring origin is on orders page...");

  await originPage.bringToFront();

  // Try direct URL first.
  await originPage.goto(workflow.origin.url, {
    waitUntil: "domcontentloaded"
  }).catch(() => {});

  await originPage.waitForTimeout(1000);

  // If table rows exist, we are done.
  if ((await originPage.locator(workflow.origin.rowSelector).count()) > 0) {
    console.log("Origin orders table found.");
    return;
  }

  console.log("Orders table not found. Trying to click Mis Pedidos...");

  const misPedidos = originPage.locator(
    'text="Mis Pedidos", a:has-text("Mis Pedidos"), button:has-text("Mis Pedidos")'
  ).first();

  if ((await misPedidos.count()) > 0) {
    await misPedidos.click();
    await originPage.waitForLoadState("networkidle").catch(() => {});
    await originPage.waitForTimeout(1500);
  }

  console.log("Current origin URL after navigation:", originPage.url());
}

async function ensureDestinationFormPage(destinationPage, workflow) {
  console.log("Ensuring destination is on new order form...");

  await destinationPage.bringToFront();

  await destinationPage.goto(workflow.destination.url, {
    waitUntil: "domcontentloaded"
  }).catch(() => {});

  await destinationPage.waitForTimeout(1000);

  if ((await destinationPage.locator("#orderId").count()) > 0) {
    console.log("Destination form found.");
    return;
  }

  console.log("Destination form not found. Trying to navigate manually...");

  const nuevoPedido = destinationPage.locator(
    'text="Nuevo Pedido", a:has-text("Nuevo Pedido"), button:has-text("Nuevo Pedido"), text="Crear Pedido"'
  ).first();

  if ((await nuevoPedido.count()) > 0) {
    await nuevoPedido.click();
    await destinationPage.waitForLoadState("networkidle").catch(() => {});
    await destinationPage.waitForTimeout(1500);
  }

  console.log("Current destination URL after navigation:", destinationPage.url());
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

  console.log("Connecting to existing Chrome on port 9222...");

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];

  let pages = context.pages();

  let originPage = pages.find((page) =>
    page.url().includes("valmart-ecru.vercel.app")
  );

  let destinationPage = pages.find((page) =>
    page.url().includes("arco-nine.vercel.app")
  );

  if (!originPage) {
    originPage = await context.newPage();
    await originPage.goto(workflow.origin.url, {
        waitUntil: "domcontentloaded"
    });
  }

if (!destinationPage) {
    destinationPage = await context.newPage();
    await destinationPage.goto(workflow.destination.url, {
        waitUntil: "domcontentloaded"
    });
}

  console.log("Opening origin...");
    await originPage.goto(workflow.origin.url, {
    waitUntil: "domcontentloaded"
    });

    await loginIfNeeded(originPage, "Origin");

    // Important: login may redirect to home/dashboard.
    // Go back to the page where the table was recorded.
    console.log("Navigating origin back to learned page...");
    await originPage.goto(workflow.origin.url, {
    waitUntil: "networkidle"
    });

  console.log("Opening destination...");
    await destinationPage.goto(workflow.destination.url, {
    waitUntil: "domcontentloaded"
    });

    await loginIfNeeded(destinationPage, "Destination");

    // Important: login may redirect to home/dashboard.
    // Go back to the learned destination form page.
    console.log("Navigating destination back to learned page...");
    await destinationPage.goto(workflow.destination.url, {
    waitUntil: "networkidle"
    });

  /* console.log("Clearing destination for clean demo...");
  await destinationPage.evaluate(() => {
    localStorage.removeItem("destination_orders");
  });

  await destinationPage.goto(workflow.destination.url, {
    waitUntil: "domcontentloaded"
  }); */

    console.log("Current origin URL:", originPage.url());
    console.log("Waiting for origin rows...");

      try {
        await originPage.locator(workflow.origin.rowSelector).first().waitFor({
            state: "visible",
            timeout: 15000
        });
        } catch (error) {
        console.log("Could not find origin rows with selector:", workflow.origin.rowSelector);
        console.log("Origin title:", await originPage.title());
        console.log("Origin URL:", originPage.url());
        console.log("Table count:", await originPage.locator("table").count());
        console.log("TR count:", await originPage.locator("tr").count());
        console.log("TD count:", await originPage.locator("td").count());

        const bodyText = await originPage.locator("body").innerText().catch(() => "");
        console.log("Body preview:");
        console.log(bodyText.slice(0, 1500));

        throw error;
    }

  await ensureOriginOrdersPage(originPage, workflow);

  console.log("Extracting origin rows...");
  const originRows = await extractOriginRows(originPage, workflow);

  console.log("Origin rows:");
  console.log(JSON.stringify(originRows, null, 2));

  await ensureDestinationFormPage(destinationPage, workflow);

  const existingDestinationIds = await getDestinationOrderIds(destinationPage);
  console.log("Existing destination order IDs:");
  console.log(existingDestinationIds);

  const destinationRows = await extractDestinationRows(destinationPage);

  console.log("Destination rows:");
  console.log(JSON.stringify(destinationRows, null, 2));

  if (
    originRows.length === 0 ||
    originRows.every((row) => Object.keys(row).length <= 2)
  ) {
    throw new Error(
      "Origin rows were found, but no useful data was extracted. Check row/cell/header selectors."
    );
  }

  console.log("Asking Gemini which rows to transfer...");
  const decision = await decideRowsToTransferWithGemini({
    workflow,
    originRows,
    destinationRows
  });

  console.log("Gemini row decision:");
  console.log(JSON.stringify(decision, null, 2));

  const rowsToTransfer = decision.rowsToTransfer
    .map((item) => originRows[item.rowIndex])
    .filter(Boolean);

  console.log("Rows selected by Gemini:");
  console.log(JSON.stringify(rowsToTransfer, null, 2));

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
  console.log("Leaving Chrome open for demo.");
}

main().catch((error) => {
  console.error("Agent failed:", error);
  process.exit(1);
});