/**
 * CONTRACT-V11-ADDRESS §5 and §8: the shell moves to another server address
 * only on the word of the server it already trusts, checked by the main
 * process itself. Pure (no Electron imports): the unit tests run under Node.
 */
import { validateServerUrl } from "../shared/url";
import type { Fetcher } from "./health";

const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;
const TIMEOUT_MS = 8000;

export type MoveRefusal = "invalid" | "not-declared" | "unreachable" | "not-trio";
export type MoveCheck = { ok: true; origin: string; code: string } | { ok: false; reason: MoveRefusal };

/** A code the shell may put in `#tasi=`: exactly the server's alphabet, nothing else. */
export function cleanCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  return CODE.test(code) ? code : null;
}

interface Health {
  ok?: unknown;
  public_url?: unknown;
  next_url?: unknown;
}

async function health(origin: string, fetcher: Fetcher): Promise<Health | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(`${origin}/api/health`, { signal: controller.signal });
    if (res.status !== 200) return null;
    const body = await res.json();
    return typeof body === "object" && body !== null ? (body as Health) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function originOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const check = validateServerUrl(raw);
  // Exactly an origin: "https://x/" or "x" are not what the page was told.
  return check.ok && (raw === check.origin || raw === `${check.origin}/`) ? check.origin : null;
}

/**
 * §5: the page asks to move to `requested` with a move code. The CURRENT
 * server must declare it as its `public_url`; the new address must answer as
 * a Trio server declaring the same.
 */
export async function verifyMove(
  current: string | null,
  request: { origin?: unknown; code?: unknown },
  fetcher: Fetcher,
): Promise<MoveCheck> {
  const origin = originOf(request.origin);
  const code = cleanCode(request.code);
  if (!current || !origin || !code || origin === current) return { ok: false, reason: "invalid" };
  const here = await health(current, fetcher);
  if (!here || here.ok !== true) return { ok: false, reason: "unreachable" };
  if (here.public_url !== origin) return { ok: false, reason: "not-declared" };
  const there = await health(origin, fetcher);
  if (!there) return { ok: false, reason: "unreachable" };
  if (there.ok !== true || there.public_url !== origin) return { ok: false, reason: "not-trio" };
  return { ok: true, origin, code };
}

export interface NextMove {
  origin: string;
  code: string;
  /** ms since the epoch */
  expiresAt: number;
}

/** §8: kept only when the current server announces `origin` as its next address. */
export async function verifyNextStore(
  current: string | null,
  request: { origin?: unknown; code?: unknown; expiresAt?: unknown },
  fetcher: Fetcher,
  now: number,
): Promise<{ ok: true; next: NextMove } | { ok: false; reason: MoveRefusal }> {
  const origin = originOf(request.origin);
  const code = cleanCode(request.code);
  const expires = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : NaN;
  if (!current || !origin || !code || origin === current || !Number.isFinite(expires) || expires <= now) {
    return { ok: false, reason: "invalid" };
  }
  const here = await health(current, fetcher);
  if (!here || here.ok !== true) return { ok: false, reason: "unreachable" };
  if (here.next_url !== origin) return { ok: false, reason: "not-declared" };
  // Never kept longer than the server's own week, whatever the page says.
  return { ok: true, next: { origin, code, expiresAt: Math.min(expires, now + 8 * 24 * 3600 * 1000) } };
}

/**
 * §8, the stored server stopped answering: is the remembered next address a
 * Trio server that says it is that address? Then the shell may go there.
 */
export async function checkNext(next: NextMove | null, fetcher: Fetcher, now: number): Promise<MoveCheck> {
  if (!next || next.expiresAt <= now || !cleanCode(next.code) || !originOf(next.origin)) {
    return { ok: false, reason: "invalid" };
  }
  const there = await health(next.origin, fetcher);
  if (!there) return { ok: false, reason: "unreachable" };
  if (there.ok !== true || (there.next_url !== next.origin && there.public_url !== next.origin)) {
    return { ok: false, reason: "not-trio" };
  }
  return { ok: true, origin: next.origin, code: next.code };
}

/** The page the shell opens on the new address: the code in the fragment, nothing else. */
export function moveUrl(origin: string, code: string): string {
  return `${origin}/#tasi=${code}`;
}
