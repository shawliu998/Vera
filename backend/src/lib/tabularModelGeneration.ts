import { completeText, streamChatWithTools, type UserApiKeys } from "./llm";
import {
  parseTabularGenerationLine,
  type TabularCellResult,
  type TabularGenerationColumn,
} from "./tabularGeneration";
import { safeErrorLog } from "./safeError";

type Dependencies = {
  complete?: typeof completeText;
  stream?: typeof streamChatWithTools;
};

export function tabularFormatPromptSuffix(format?: string, tags?: string[]) {
  switch (format) {
    case "bulleted_list":
      return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
    case "number":
      return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
    case "percentage":
      return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
    case "monetary_amount":
      return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
    case "currency":
      return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
    case "yes_no":
      return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
    case "date":
      return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
    case "tag":
      return tags?.length
        ? ` The "summary" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((tag) => `[[${tag}]]`).join(", ")}. No other text. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
        : "";
    default:
      return "";
  }
}

const SINGLE_CELL_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

export async function queryTabularCell(input: {
  model: string;
  filename: string;
  documentText: string;
  columnPrompt: string;
  format?: string;
  tags?: string[];
  apiKeys?: UserApiKeys;
  dependencies?: Dependencies;
}): Promise<TabularCellResult | null> {
  const suffix = tabularFormatPromptSuffix(input.format, input.tags);
  const fullPrompt = `${input.columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;
  let raw: string;
  try {
    raw = await (input.dependencies?.complete ?? completeText)({
      model: input.model,
      systemPrompt: SINGLE_CELL_SYSTEM,
      user: `Document: ${input.filename}\n\n${input.documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
      maxTokens: 2048,
      apiKeys: input.apiKeys,
    });
  } catch (error) {
    console.error("[queryTabularCell] completion failed", safeErrorLog(error));
    return null;
  }
  try {
    const parsed = JSON.parse(
      raw
        .replace(/^```(?:json)?\n?/i, "")
        .replace(/\n?```$/, "")
        .trim(),
    ) as Record<string, unknown>;
    return {
      summary:
        String(parsed.summary ?? parsed.value ?? "").trim() || "Not addressed",
      flag: (["green", "grey", "yellow", "red"] as const).includes(
        parsed.flag as "green",
      )
        ? (parsed.flag as TabularCellResult["flag"])
        : "grey",
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return raw.trim()
      ? { summary: raw.trim().slice(0, 500), flag: "grey", reasoning: "" }
      : null;
  }
}

const ALL_COLUMNS_SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

export async function queryTabularColumns(input: {
  model: string;
  filename: string;
  documentText: string;
  columns: TabularGenerationColumn[];
  onResult: (columnIndex: number, result: TabularCellResult) => Promise<void>;
  apiKeys?: UserApiKeys;
  dependencies?: Dependencies;
}) {
  const columnsDescription = input.columns
    .map((column) => {
      const suffix = tabularFormatPromptSuffix(column.format, column.tags);
      return `Column ${column.index} — "${column.name}": ${column.prompt}${suffix} If not found, state "Not Found".`;
    })
    .join("\n");
  const user = `Document: ${input.filename}\n\n${input.documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDescription}`;
  let buffer = "";
  const pending: Promise<unknown>[] = [];
  const expected = new Set(input.columns.map((column) => column.index));
  const emitted = new Set<number>();
  const processLine = async (line: string) => {
    const parsed = parseTabularGenerationLine(line, expected);
    if (parsed.kind !== "result" || emitted.has(parsed.columnIndex)) return;
    emitted.add(parsed.columnIndex);
    await input.onResult(parsed.columnIndex, parsed.result);
  };

  let streamError: unknown = null;
  try {
    await (input.dependencies?.stream ?? streamChatWithTools)({
      model: input.model,
      systemPrompt: ALL_COLUMNS_SYSTEM,
      messages: [{ role: "user", content: user }],
      tools: [],
      apiKeys: input.apiKeys,
      callbacks: {
        onContentDelta: (delta) => {
          buffer += delta;
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            pending.push(processLine(line));
          }
        },
      },
    });
  } catch (error) {
    streamError = error;
  }
  if (buffer.trim()) pending.push(processLine(buffer));
  await Promise.all(pending);
  if (streamError) throw streamError;
}
