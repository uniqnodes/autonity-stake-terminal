import { NextRequest } from "next/server";
import { createNonceResponse, guardRequest, jsonError } from "@/lib/server/api-security";

type NonceBody = {
  address?: string;
};

export async function POST(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "auth-nonce",
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: NonceBody;
  try {
    body = (await request.json()) as NonceBody;
  } catch {
    return jsonError(400, "invalid_body", "Request body must be valid JSON.");
  }

  const address = body.address || "";
  if (!address) {
    return jsonError(400, "missing_address", "Wallet address is required.");
  }

  const response = createNonceResponse(request, address);
  guard.refreshSessionCookie(response);
  return response;
}
