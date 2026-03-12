import { NextRequest, NextResponse } from "next/server";
import { guardRequest, readSessionStatus, refreshSessionCookie } from "@/lib/server/api-security";

export async function GET(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "auth-session",
  });
  if (!guard.ok) {
    return guard.response;
  }

  const expectedAddress = request.nextUrl.searchParams.get("address");
  const status = readSessionStatus(request, expectedAddress);

  const response = NextResponse.json(
    {
      authenticated: status.authenticated,
      address: status.address,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );

  if (status.authenticated && status.address && status.shouldRefresh) {
    refreshSessionCookie(response, status.address);
  } else {
    guard.refreshSessionCookie(response);
  }

  return response;
}
