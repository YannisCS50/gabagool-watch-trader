const CLOB_URL = 'https://clob.polymarket.com';

type TimeResponse = any;

let cachedOffsetSeconds = 0;
let cachedAtMs = 0;

const TTL_MS = 30_000;

function parseServerUnixSeconds(payload: TimeResponse): number | null {
  // Expected shapes seen in clients/APIs:
  // - { serverTime: 1700000000 }
  // - { timestamp: 1700000000 }
  // - { time: 1700000000 }
  // - { t: 1700000000 }
  // - 1700000000
  const raw =
    typeof payload === 'number'
      ? payload
      : payload?.serverTime ??
        payload?.timestamp ??
        payload?.time ??
        payload?.t ??
        payload?.ts;

  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n)) return null;

  // If API ever returns ms, normalize to seconds.
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

async function fetchClobServerUnixSeconds(): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_URL}/time`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return parseServerUnixSeconds(data);
  } catch {
    return null;
  }
}

/**
 * Returns `server_time_seconds - local_time_seconds`.
 * Cached for TTL_MS to avoid hammering /time.
 */
export async function getClobTimeOffsetSeconds(opts?: { force?: boolean }): Promise<number> {
  const nowMs = Date.now();
  if (!opts?.force && cachedAtMs && nowMs - cachedAtMs < TTL_MS) return cachedOffsetSeconds;

  const serverSec = await fetchClobServerUnixSeconds();
  if (serverSec == null) {
    // Keep previous cached offset (could be 0) rather than oscillating.
    cachedAtMs = nowMs;
    return cachedOffsetSeconds;
  }

  const localSec = Math.floor(nowMs / 1000);
  cachedOffsetSeconds = serverSec - localSec;
  cachedAtMs = nowMs;
  return cachedOffsetSeconds;
}

/**
 * Temporarily patches Date.now() so libraries that internally compute
 * `Math.floor(Date.now()/1000)` use the server-synced time.
 */
export async function withDateNowOffset<T>(
  offsetSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  if (!offsetSeconds) return fn();

  const originalNow = Date.now;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  Date.now = () => originalNow() + offsetSeconds * 1000;
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}
