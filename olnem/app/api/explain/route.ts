// POST /api/explain
//
// Plain-language explanation of a named evaluation output, component, or decision.
//
// Input: { targetType: "component" | "output" | "decision"; text: string }
// Output: { explanation: string }
//
// The explanation agent receives ONLY what is in the request body.
// This route performs no session state lookups. There is no session ID parameter.
// The caller is responsible for passing the text to explain explicitly.

import { callExplanationAgent } from "@/lib/agents/explanation";
import type { ExplainTargetType } from "@/lib/agents/explanation";

const VALID_TARGET_TYPES = new Set<ExplainTargetType>([
  "component",
  "output",
  "decision",
]);

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).targetType !== "string" ||
    typeof (body as Record<string, unknown>).text !== "string" ||
    !(body as { text: string }).text.trim()
  ) {
    return new Response(
      "Body must include { targetType: string; text: string }",
      { status: 400 }
    );
  }

  const { targetType, text } = body as { targetType: string; text: string };

  if (!VALID_TARGET_TYPES.has(targetType as ExplainTargetType)) {
    return new Response(
      `targetType must be one of: ${[...VALID_TARGET_TYPES].join(", ")}`,
      { status: 400 }
    );
  }

  try {
    const explanation = await callExplanationAgent(
      { targetType: targetType as ExplainTargetType, text: text.trim() },
      // Propagate client disconnect — no reason to continue if the tab closed.
      request.signal
    );
    return Response.json({ explanation });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 502 });
  }
}
