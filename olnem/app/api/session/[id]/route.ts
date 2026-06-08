// GET /api/session/[id]
//
// Returns the full session state for the given session ID.
// Used by the visualization layer to read the completed validation stack.

import { getSession } from "@/lib/session/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return new Response("Session not found", { status: 404 });
  return Response.json(session);
}
