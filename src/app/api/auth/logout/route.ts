import { NextRequest } from "next/server";
import { clearSessionResponse, guardRequest } from "@/lib/server/api-security";

export async function POST(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "auth-logout",
  });
  if (!guard.ok) {
    return guard.response;
  }

  return clearSessionResponse();
}
