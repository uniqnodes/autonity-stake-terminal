import registry from "@/data/validator-registry.json";
import { guardRequest } from "@/lib/server/api-security";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "api-read",
    requireSession: true,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const response = NextResponse.json(registry, {
    headers: {
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
    },
  });
  guard.refreshSessionCookie(response);
  return response;
}
