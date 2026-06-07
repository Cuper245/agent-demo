require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function extractJson(text) {
  const cleaned = String(text)
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Gemini decision response did not contain JSON.");
  }

  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

async function decideRowsToTransferWithGemini({
  workflow,
  originRows,
  destinationRows
}) {
  const prompt = `
You are the decision layer of a browser automation agent.

The agent observed one manual transfer from an origin system to a destination system.
Now you must decide which origin rows should be transferred next.

Important:
- Do NOT transfer irrelevant rows.
- Do NOT transfer rows already present in the destination.
- Use the learned workflow mappings to understand what the primary order identifier is.
- The origin and destination may use different labels.
- Use semantic reasoning. For example, "ID PEDIDO" may correspond to "ID Pedido".
- Return only valid JSON. No markdown.

Learned workflow:
${JSON.stringify(workflow, null, 2)}

Current origin rows:
${JSON.stringify(originRows, null, 2)}

Current destination rows:
${JSON.stringify(destinationRows, null, 2)}

Return this JSON shape:
{
  "primaryKey": {
    "originLabel": "",
    "destinationLabel": "",
    "reason": ""
  },
  "rowsToTransfer": [
    {
      "originPrimaryKey": "",
      "rowIndex": 0,
      "reason": ""
    }
  ],
  "rowsToSkip": [
    {
      "originPrimaryKey": "",
      "rowIndex": 0,
      "reason": ""
    }
  ]
}
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt
  });

  const parsed = extractJson(response.text);

  if (!Array.isArray(parsed.rowsToTransfer)) {
    throw new Error("Gemini decision missing rowsToTransfer array.");
  }

  return parsed;
}

module.exports = {
  decideRowsToTransferWithGemini
};