import { NextRequest } from "next/server";
import {
  createSessionResponse,
  guardRequest,
  jsonError,
  verifySignedChallenge,
} from "@/lib/server/api-security";

type VerifyBody = {
  address?: string;
  signature?: string;
};

export async function POST(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "auth-verify",
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: VerifyBody;
  try {
    body = (await request.json()) as VerifyBody;
  } catch {
    return jsonError(400, "invalid_body", "Request body must be valid JSON.");
  }

  const address = body.address || "";
  const signature = body.signature || "";
  if (!address || !signature) {
    return jsonError(400, "missing_fields", "Address and signature are required.");
  }

  const verification = verifySignedChallenge(request, address, signature);
  if (!verification.ok) {
    return verification.response;
  }

  return createSessionResponse(verification.normalizedAddress);
}
