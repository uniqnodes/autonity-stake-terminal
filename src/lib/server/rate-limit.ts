import { NextRequest } from "next/server";

type WindowCounter = {
  count: number;
  resetAt: number;
};

type ViolationCounter = {
  count: number;
  resetAt: number;
};

const windowCounters = new Map<string, WindowCounter>();
const violationCounters = new Map<string, ViolationCounter>();
const temporaryBlocks = new Map<string, number>();

const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

function nowMs() {
  return Date.now();
}

function cleanup() {
  const now = nowMs();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;

  for (const [key, value] of windowCounters.entries()) {
    if (value.resetAt <= now) {
      windowCounters.delete(key);
    }
  }

  for (const [key, value] of violationCounters.entries()) {
    if (value.resetAt <= now) {
      violationCounters.delete(key);
    }
  }

  for (const [key, value] of temporaryBlocks.entries()) {
    if (value <= now) {
      temporaryBlocks.delete(key);
    }
  }
}

function parseForwardedFor(value: string | null) {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

export function getClientIp(request: NextRequest) {
  const fromForwarded = parseForwardedFor(request.headers.get("x-forwarded-for"));
  const fromRealIp = request.headers.get("x-real-ip");
  return fromForwarded || fromRealIp || "unknown";
}

export function isIpBlocked(ip: string) {
  cleanup();

  const envBlocked = (process.env.API_BLOCKED_IPS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (envBlocked.includes(ip)) return true;

  const blockedUntil = temporaryBlocks.get(ip);
  if (!blockedUntil) return false;
  if (blockedUntil <= nowMs()) {
    temporaryBlocks.delete(ip);
    return false;
  }
  return true;
}

export function registerViolation(ip: string) {
  cleanup();
  const now = nowMs();
  const key = `violation:${ip}`;
  const current = violationCounters.get(key);
  const windowMs = 10 * 60_000;

  if (!current || current.resetAt <= now) {
    violationCounters.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  current.count += 1;
  if (current.count >= 8) {
    // Temporarily block highly abusive clients.
    temporaryBlocks.set(ip, now + 30 * 60_000);
    violationCounters.delete(key);
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number) {
  cleanup();
  const now = nowMs();
  const current = windowCounters.get(key);

  if (!current || current.resetAt <= now) {
    windowCounters.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: 0,
    };
  }

  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: 0,
  };
}
