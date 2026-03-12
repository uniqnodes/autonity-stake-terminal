import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getAddress, verifyMessage } from "ethers";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp, isIpBlocked, registerViolation } from "@/lib/server/rate-limit";

type SessionTokenPayload = {
  t: "session";
  a: string;
  i: number;
  e: number;
  v: 1;
};

type NonceTokenPayload = {
  t: "nonce";
  a: string;
  n: string;
  d: string;
  e: number;
  v: 1;
};

type GuardEndpoint = "auth-nonce" | "auth-verify" | "auth-session" | "auth-logout" | "api-read";

type RateRule = {
  perMinuteIp: number;
  perDayIp: number;
  perMinuteSession?: number;
};

type ParsedSession = {
  address: string;
  issuedAt: number;
  expiresAt: number;
};

const SESSION_COOKIE_NAME = "autodesk_api_session";
const NONCE_COOKIE_NAME = "autodesk_api_nonce";
const SESSION_TTL_SECONDS = Number(process.env.API_SESSION_TTL_SECONDS || 7 * 24 * 60 * 60);
const NONCE_TTL_SECONDS = Number(process.env.API_NONCE_TTL_SECONDS || 5 * 60);
const SESSION_REFRESH_THRESHOLD_SECONDS = Number(
  process.env.API_SESSION_REFRESH_THRESHOLD_SECONDS || 24 * 60 * 60
);

const RATE_RULES: Record<GuardEndpoint, RateRule> = {
  "auth-nonce": {
    perMinuteIp: 20,
    perDayIp: 500,
  },
  "auth-verify": {
    perMinuteIp: 20,
    perDayIp: 400,
  },
  "auth-session": {
    perMinuteIp: 90,
    perDayIp: 3000,
  },
  "auth-logout": {
    perMinuteIp: 40,
    perDayIp: 1500,
  },
  "api-read": {
    perMinuteIp: 90,
    perDayIp: 2500,
    perMinuteSession: 120,
  },
};

function getAuthSecret() {
  return (
    process.env.API_AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    `autodesk-dev-secret-${process.env.VERCEL_URL || "local"}`
  );
}

function normalizeAddress(address: string) {
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function base64UrlEncode(text: string) {
  return Buffer.from(text, "utf8").toString("base64url");
}

function base64UrlDecode(text: string) {
  return Buffer.from(text, "base64url").toString("utf8");
}

function signPayload(payloadBase64: string) {
  return createHmac("sha256", getAuthSecret()).update(payloadBase64).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function encodeToken<T extends SessionTokenPayload | NonceTokenPayload>(payload: T) {
  const payloadBase64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

function decodeToken<T extends SessionTokenPayload | NonceTokenPayload>(token: string): T | null {
  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) return null;
  const expected = signPayload(payloadBase64);
  if (!safeEqual(signature, expected)) return null;

  try {
    return JSON.parse(base64UrlDecode(payloadBase64)) as T;
  } catch {
    return null;
  }
}

function originFromRequest(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return null;
  const proto =
    request.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function isAllowedOrigin(request: NextRequest) {
  const expectedOrigin = originFromRequest(request);
  if (!expectedOrigin) return true;

  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin) {
    return false;
  }

  const referer = request.headers.get("referer");
  if (referer && !referer.startsWith(expectedOrigin)) {
    return false;
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) {
    return false;
  }

  return true;
}

function addRetryAfter(headers: Headers, retryAfterSeconds: number) {
  if (retryAfterSeconds > 0) {
    headers.set("Retry-After", String(retryAfterSeconds));
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  retryAfterSeconds = 0
) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  addRetryAfter(headers, retryAfterSeconds);
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers,
    }
  );
}

function enforceRateLimit(ip: string, sessionAddress: string | null, endpoint: GuardEndpoint) {
  const rules = RATE_RULES[endpoint];

  const minuteIp = checkRateLimit(`minute:ip:${endpoint}:${ip}`, rules.perMinuteIp, 60_000);
  if (!minuteIp.allowed) return minuteIp;

  const dayIp = checkRateLimit(`day:ip:${endpoint}:${ip}`, rules.perDayIp, 24 * 60 * 60_000);
  if (!dayIp.allowed) return dayIp;

  if (rules.perMinuteSession && sessionAddress) {
    const minuteSession = checkRateLimit(
      `minute:session:${endpoint}:${sessionAddress}`,
      rules.perMinuteSession,
      60_000
    );
    if (!minuteSession.allowed) return minuteSession;
  }

  return { allowed: true as const, remaining: 0, retryAfterSeconds: 0 };
}

function parseSessionFromRequest(request: NextRequest): ParsedSession | null {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = decodeToken<SessionTokenPayload>(token);
  if (!payload || payload.t !== "session" || payload.v !== 1) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.e <= now) return null;

  const normalizedAddress = normalizeAddress(payload.a);
  if (!normalizedAddress) return null;

  return {
    address: normalizedAddress,
    issuedAt: payload.i,
    expiresAt: payload.e,
  };
}

function makeSessionToken(address: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    t: "session",
    a: address,
    i: now,
    e: now + SESSION_TTL_SECONDS,
    v: 1,
  };
  return encodeToken(payload);
}

function clearCookie(response: NextResponse, name: string) {
  response.cookies.set({
    name,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

function setNonceCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: NONCE_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: NONCE_TTL_SECONDS,
  });
}

export function buildSignInMessage(address: string, nonce: string, domain: string) {
  return [
    "Autonity Staking Terminal",
    "",
    "Sign this message to open a secure API session.",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Domain: ${domain}`,
  ].join("\n");
}

export function createNonceChallenge(request: NextRequest, address: string) {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return {
      error: jsonError(400, "invalid_address", "Wallet address is not valid."),
      challenge: null,
    };
  }

  const domain = request.headers.get("x-forwarded-host") || request.headers.get("host") || "unknown";
  const nonce = randomBytes(18).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const payload: NonceTokenPayload = {
    t: "nonce",
    a: normalizedAddress,
    n: nonce,
    d: domain,
    e: now + NONCE_TTL_SECONDS,
    v: 1,
  };

  const nonceToken = encodeToken(payload);
  const message = buildSignInMessage(normalizedAddress, nonce, domain);

  return {
    error: null,
    challenge: {
      message,
      expiresAt: payload.e,
      nonceToken,
    },
  };
}

export function verifySignedChallenge(
  request: NextRequest,
  address: string,
  signature: string
): { ok: true; normalizedAddress: string } | { ok: false; response: NextResponse } {
  const normalizedAddress = normalizeAddress(address);
  if (!normalizedAddress) {
    return {
      ok: false,
      response: jsonError(400, "invalid_address", "Wallet address is not valid."),
    };
  }

  const nonceToken = request.cookies.get(NONCE_COOKIE_NAME)?.value;
  if (!nonceToken) {
    return {
      ok: false,
      response: jsonError(401, "nonce_missing", "Signature challenge is missing or expired."),
    };
  }

  const noncePayload = decodeToken<NonceTokenPayload>(nonceToken);
  if (!noncePayload || noncePayload.t !== "nonce" || noncePayload.v !== 1) {
    return {
      ok: false,
      response: jsonError(401, "nonce_invalid", "Signature challenge is invalid."),
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (noncePayload.e <= now) {
    return {
      ok: false,
      response: jsonError(401, "nonce_expired", "Signature challenge expired."),
    };
  }

  if (noncePayload.a !== normalizedAddress) {
    return {
      ok: false,
      response: jsonError(401, "nonce_address_mismatch", "Challenge does not match active wallet."),
    };
  }

  try {
    const message = buildSignInMessage(noncePayload.a, noncePayload.n, noncePayload.d);
    const recovered = normalizeAddress(verifyMessage(message, signature));
    if (!recovered || recovered !== normalizedAddress) {
      return {
        ok: false,
        response: jsonError(401, "signature_invalid", "Signature does not match wallet address."),
      };
    }
  } catch {
    return {
      ok: false,
      response: jsonError(401, "signature_invalid", "Signature could not be verified."),
    };
  }

  return {
    ok: true,
    normalizedAddress,
  };
}

type GuardResult =
  | {
      ok: false;
      response: NextResponse;
    }
  | {
      ok: true;
      sessionAddress: string | null;
      refreshSessionCookie: (response: NextResponse) => void;
    };

export function guardRequest(
  request: NextRequest,
  options: {
    endpoint: GuardEndpoint;
    requireSession?: boolean;
    expectedAddress?: string | null;
  }
): GuardResult {
  const ip = getClientIp(request);

  if (isIpBlocked(ip)) {
    return {
      ok: false,
      response: jsonError(403, "ip_blocked", "Access temporarily blocked."),
    };
  }

  if (!isAllowedOrigin(request)) {
    registerViolation(ip);
    return {
      ok: false,
      response: jsonError(403, "origin_not_allowed", "Request origin is not allowed."),
    };
  }

  const session = parseSessionFromRequest(request);
  const sessionAddress = session?.address || null;

  if (options.requireSession && !sessionAddress) {
    registerViolation(ip);
    return {
      ok: false,
      response: jsonError(401, "session_required", "Signed API session required."),
    };
  }

  if (options.expectedAddress && sessionAddress) {
    const expected = normalizeAddress(options.expectedAddress);
    if (!expected || expected !== sessionAddress) {
      registerViolation(ip);
      return {
        ok: false,
        response: jsonError(403, "session_address_mismatch", "Session does not match wallet."),
      };
    }
  }

  const limit = enforceRateLimit(ip, sessionAddress, options.endpoint);
  if (!limit.allowed) {
    registerViolation(ip);
    return {
      ok: false,
      response: jsonError(429, "rate_limited", "Too many requests. Slow down.", limit.retryAfterSeconds),
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const shouldRefresh =
    Boolean(sessionAddress && session && session.expiresAt - now <= SESSION_REFRESH_THRESHOLD_SECONDS);
  const refreshedToken = shouldRefresh && sessionAddress ? makeSessionToken(sessionAddress) : null;

  return {
    ok: true,
    sessionAddress,
    refreshSessionCookie: (response: NextResponse) => {
      if (refreshedToken) {
        setSessionCookie(response, refreshedToken);
      }
    },
  };
}

export function createNonceResponse(request: NextRequest, address: string) {
  const challenge = createNonceChallenge(request, address);
  if (challenge.error || !challenge.challenge) {
    return challenge.error || jsonError(500, "nonce_failed", "Could not create nonce challenge.");
  }

  const response = NextResponse.json(
    {
      message: challenge.challenge.message,
      expiresAt: challenge.challenge.expiresAt,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
  setNonceCookie(response, challenge.challenge.nonceToken);
  return response;
}

export function createSessionResponse(address: string) {
  const token = makeSessionToken(address);
  const response = NextResponse.json(
    {
      authenticated: true,
      address,
      expiresInSeconds: SESSION_TTL_SECONDS,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
  setSessionCookie(response, token);
  clearCookie(response, NONCE_COOKIE_NAME);
  return response;
}

export function clearSessionResponse() {
  const response = NextResponse.json(
    { ok: true },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
  clearCookie(response, SESSION_COOKIE_NAME);
  clearCookie(response, NONCE_COOKIE_NAME);
  return response;
}

export function readSessionStatus(request: NextRequest, expectedAddress?: string | null) {
  const session = parseSessionFromRequest(request);
  if (!session) {
    return {
      authenticated: false,
      address: null,
      shouldRefresh: false,
    };
  }

  if (expectedAddress) {
    const expected = normalizeAddress(expectedAddress);
    if (!expected || expected !== session.address) {
      return {
        authenticated: false,
        address: null,
        shouldRefresh: false,
      };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    authenticated: true,
    address: session.address,
    shouldRefresh: session.expiresAt - now <= SESSION_REFRESH_THRESHOLD_SECONDS,
  };
}

export function refreshSessionCookie(response: NextResponse, address: string) {
  setSessionCookie(response, makeSessionToken(address));
}
