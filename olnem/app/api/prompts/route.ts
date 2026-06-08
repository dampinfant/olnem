// GET /api/prompts — list all documents in the registry.
// Returns full DocumentRecord objects (including content).
// Used by DocumentsPanel to populate the prompt management view.

import { getAllDocuments } from "@/lib/documents/registry";

export async function GET(): Promise<Response> {
  return Response.json(getAllDocuments());
}
