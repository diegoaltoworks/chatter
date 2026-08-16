/**
 * Schema-driven parameter extraction - pulls structured params out of a
 * message using the flow's `instructions.md` and JSON schema, across as many
 * turns as it takes to fill every required field.
 */

import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import type { FlowExtractionResult, LoadedFlow } from "./types";

/** A model that isn't sure about a field tends to emit an explicit `null` rather than omit the key; both mean "not filled". */
function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Extracts (and merges) params from `message` against `flow`'s schema.
 *
 * `now` is injectable so date-relative prompt context ("tomorrow") is
 * deterministic in tests; defaults to the real clock.
 */
export async function extractParameters(
  client: OpenAI,
  model: string,
  flow: LoadedFlow,
  message: string,
  existingParams: Record<string, unknown>,
  now: () => number = Date.now,
): Promise<FlowExtractionResult> {
  const instructions = readFileSync(flow.instructionsPath, "utf-8");
  const schema = flow.definition.schema;
  const properties = schema.properties || {};
  const required = schema.required || [];

  const schemaDescription = Object.entries(properties)
    .map(
      ([key, field]) =>
        `- ${key} (${field.type}${required.includes(key) ? ", required" : ""}): ${field.description || ""}`,
    )
    .join("\n");

  const existingParamsStr =
    Object.keys(existingParams).length > 0
      ? `\n\nAlready collected:\n${JSON.stringify(existingParams, null, 2)}`
      : "";

  const missingFields = required.filter((key) => isMissing(existingParams[key]));
  const currentlyAsking = missingFields.length > 0 ? missingFields[0] : null;

  const nowDate = new Date(now());
  const todayStr = nowDate.toISOString().split("T")[0];
  const currentYear = nowDate.getFullYear();
  const currentMonth = nowDate.getMonth() + 1;
  const nextYear = currentYear + 1;
  const tomorrow = new Date(nowDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];

  const dateContext = `\n\n## CRITICAL DATE CONTEXT
TODAY IS: ${todayStr} (year ${currentYear}, month ${currentMonth})

**DATE EXTRACTION RULES:**
- "tomorrow" = ${tomorrowStr}
- Months 1-${currentMonth} = year ${nextYear}
- Months ${currentMonth + 1}-12 = year ${currentYear}
- NEVER output a date before ${todayStr}`;

  const currentFieldHint = currentlyAsking
    ? `\n\n## IMPORTANT CONTEXT
We just asked the user for: "${currentlyAsking}"
If the user's response is a simple value, interpret it as the value for the "${currentlyAsking}" parameter.`
    : "";

  const systemPrompt = `${instructions}
${dateContext}

## Schema
${schemaDescription}
${existingParamsStr}
${currentFieldHint}

## Task
Extract any parameters from the user's message that match the schema above.
Return JSON with:
- "extractedParams": object with any NEW parameters found

Do not compute "allParamsFilled" - the caller recomputes it from the merged params.`;

  // Calls the OpenAI client directly rather than going through
  // core/answer.ts: this extracts structured slot values, it never becomes
  // a reply sent to the user, so it is not a "chat surface" and is exempt
  // from the answerFn seam (see docs/ARCHITECTURE.md, invariant 1).
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
  });

  const content = response.choices[0]?.message?.content || "{}";
  const result = JSON.parse(content) as { extractedParams?: Record<string, unknown> };

  // A model unsure about a field tends to emit `{"field": null}` rather than
  // omit the key. Merging that in verbatim would satisfy `key in mergedParams`
  // forever while the value stays empty — the flow would never see the field
  // as missing again, and never re-prompt for it either.
  const extractedParams = Object.fromEntries(
    Object.entries(result.extractedParams || {}).filter(([, value]) => !isMissing(value)),
  );

  const mergedParams = { ...existingParams, ...extractedParams };
  const allParamsFilled = required.every((key) => !isMissing(mergedParams[key]));

  let nextPrompt: string | undefined;
  if (!allParamsFilled) {
    const missingKey = required.find((key) => isMissing(mergedParams[key]));
    if (missingKey) {
      nextPrompt = `What is the ${missingKey.replace(/([A-Z])/g, " $1").toLowerCase()}?`;
    }
  }

  return { extractedParams, allParamsFilled, nextPrompt };
}
