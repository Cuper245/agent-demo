
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function compactEvent(event) {
  return {
    eventType: event.eventType,
    system: event.system,
    url: event.url,
    title: event.title || null,

    selectedText: event.selectedText || null,
    inputValue: event.inputValue || null,
    pastedText: event.pastedText || null,

    element: event.element
      ? {
          tag: event.element.tag || null,
          id: event.element.id || null,
          className: event.element.className || null,
          selector: event.element.selector || null,
          text: event.element.text || null,
          value: event.element.value || null,
          placeholder: event.element.placeholder || null,
          ariaLabel: event.element.ariaLabel || null,
          name: event.element.name || null,
          type: event.element.type || null,

          dataField: event.element.dataField || null,
          dataOriginField: event.element.dataOriginField || null,
          dataDestinationField: event.element.dataDestinationField || null,

          inputLabel: event.element.inputLabel || null,
          tableHeader: event.element.tableHeader || null,
          detailLabel: event.element.detailLabel || null,
          nearbyText: event.element.nearbyText
            ? String(event.element.nearbyText).slice(0, 300)
            : null
        }
      : null
  };
}

function extractJson(text) {
  const cleaned = String(text)
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Gemini response did not contain JSON.");
  }

  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Workflow is not an object.");
  }

  if (!Array.isArray(workflow.mappings)) {
    throw new Error("Workflow does not contain a mappings array.");
  }

  const validMappings = workflow.mappings.filter((mapping) => {
    return (
      mapping &&
      mapping.destinationSelector &&
      (mapping.originLabel || mapping.originField || mapping.observedValue)
    );
  });

  if (validMappings.length === 0) {
    throw new Error("Gemini returned zero usable mappings.");
  }

  return {
    ...workflow,
    mappings: validMappings
  };
}

async function learnWorkflowWithGemini({ originEvents, destinationEvents }) {
  const trace = {
    originEvents: originEvents.map(compactEvent),
    destinationEvents: destinationEvents.map(compactEvent)
  };

  const prompt = `
You are an AI workflow learner for a browser automation agent.

A user manually transferred one order from an origin web system to a destination web system.

Your task:
Infer a reusable workflow mapping from origin fields to destination fields.

Important:
- Do NOT memorize only the example values.
- Learn which origin field maps to which destination field.
- Use copied values, pasted values, typed values, table headers, labels, placeholders, selectors, nearby text, and URLs.
- Origin and destination field names may be different.
- The destination may be in Spanish.
- Some values may be formatted differently, for example "$52.28" in origin and "52.28" in destination.
- If multiple products are present, infer mappings for repeated product fields too.
- Return ONLY valid JSON. No markdown. No explanation outside JSON.

Required JSON shape:

{
  "workflowName": "database_row_transfer",
  "origin": {
    "rowSelector": "string",
    "cellSelector": "string",
    "tableHeadersSelector": "string"
  },
  "destination": {
    "formSelector": "string",
    "submitSelector": "string",
    "resultRowsSelector": "string"
  },
  "mappings": [
    {
      "originLabel": "string or null",
      "originField": "string or null",
      "originSelector": "string or null",
      "destinationLabel": "string",
      "destinationField": "string or null",
      "destinationSelector": "string",
      "observedValue": "string",
      "reason": "short reason explaining the mapping",
      "confidence": 0.0
    }
  ]
}

Selector guidance:
- Prefer stable selectors like #id, [name="..."], [data-field="..."], [data-testid="..."].
- Avoid long Tailwind/class selectors if a better selector exists.
- If there is no stable selector, use the best selector observed.
- For table-like origin pages, use generic selectors such as "tbody tr", "td", "thead th" if appropriate.
- For destination forms, use "#id" selectors when available.

Trace:
${JSON.stringify(trace, null, 2)}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt
  });

  const parsed = extractJson(response.text);
  return validateWorkflow(parsed);
}

module.exports = {
  learnWorkflowWithGemini
};