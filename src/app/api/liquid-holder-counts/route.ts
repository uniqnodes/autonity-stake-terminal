import { guardRequest } from "@/lib/server/api-security";
import { NextRequest, NextResponse } from "next/server";

const BLOCKSCOUT_TOKEN_API_BASE = "https://blockscout.akeyra.klazomenai.dev/api/v2/tokens/";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MAX_ADDRESSES = 32;

async function fetchHolders(address: string) {
  try {
    const res = await fetch(`${BLOCKSCOUT_TOKEN_API_BASE}${address}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) {
      return null;
    }

    const json = (await res.json()) as { holders?: string | number };
    const holdersRaw = json.holders;
    const holders =
      typeof holdersRaw === "number"
        ? holdersRaw
        : typeof holdersRaw === "string"
          ? Number.parseInt(holdersRaw, 10)
          : Number.NaN;

    return Number.isFinite(holders) ? holders : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const guard = guardRequest(request, {
    endpoint: "api-read",
    requireSession: true,
  });
  if (!guard.ok) {
    return guard.response;
  }

  const raw = request.nextUrl.searchParams.get("addresses") || "";
  const addresses = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()))]
    .filter((item) => ADDRESS_RE.test(item))
    .slice(0, MAX_ADDRESSES);

  if (addresses.length === 0) {
    const response = NextResponse.json(
      { holdersByToken: {} },
      {
        headers: {
          "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        },
      }
    );
    guard.refreshSessionCookie(response);
    return response;
  }

  const results = await Promise.all(addresses.map(async (address) => [address, await fetchHolders(address)]));
  const holdersByToken = Object.fromEntries(results);

  const response = NextResponse.json(
    { holdersByToken },
    {
      headers: {
        "Cache-Control": "private, max-age=300, stale-while-revalidate=1800",
      },
    }
  );
  guard.refreshSessionCookie(response);
  return response;
}
