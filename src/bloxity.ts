import { AD_TOKEN_MAX_LEN, BLOXITY_API_DEFAULT, BLOXITY_BOARDS, BLOXITY_TIMEOUT_MS, GAME_SLUG_DEFAULT } from "./constants.js";

// Every Bloxity HTTP call lives here. All of them are env-driven, time out after
// BLOXITY_TIMEOUT_MS and NEVER throw: a failure is a returned value. Tests swap the fetch.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const realFetch: FetchLike = (url, init) => fetch(url, init);
let fetchImpl: FetchLike = realFetch;

// Test-only seam; pass null to restore the real fetch.
export function __setFetchForTest(f: FetchLike | null): void {
  fetchImpl = f ?? realFetch;
}

export const apiBase = () => (process.env.BLOXITY_API_URL || BLOXITY_API_DEFAULT).replace(/\/+$/, "");
export const gameSlug = () => process.env.BLOXITY_GAME_ID || GAME_SLUG_DEFAULT;

async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; data: any } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BLOXITY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(`${apiBase()}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      // no / invalid JSON body
    }
    return { status: res.status, data };
  } catch (err) {
    console.warn(`[bloxity] ${path} failed:`, (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifiedUser {
  id: string; // user._id
  username: string;
  pfp: string;
  carriedFrom: string[];
}

// POST /v1/auth/game-token/verify with the player's Legion.SDK.auth.getToken(). Null = not a
// verified user (invalid token, unreachable API, malformed answer): treat the player as a guest.
export async function verifyToken(token: string): Promise<VerifiedUser | null> {
  if (typeof token !== "string" || !token || token.length > AD_TOKEN_MAX_LEN) return null;
  const r = await post("/v1/auth/game-token/verify", { gameSlug: gameSlug() }, token);
  const d = r?.data;
  const u = d?.user;
  if (!r || d?.valid !== true || !u || typeof u._id !== "string" || !u._id || u._id.length > 128) return null;
  const name = typeof u.displayName === "string" && u.displayName ? u.displayName : typeof u.username === "string" ? u.username : "";
  const carried = Array.isArray(d.carriedFrom)
    ? d.carriedFrom.filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 128).slice(0, 20)
    : [];
  return { id: u._id, username: name, pfp: typeof u.pfp === "string" ? u.pfp : "", carriedFrom: carried };
}

export interface ScoreRow {
  board: string;
  userId: string;
  score: number;
}
export interface ReportResult {
  ok: boolean;
  skipped?: boolean;
  summary: string;
}

// POST /v1/leaderboards/hosted/{game}/report. A no-op (skipped) while BLOXITY_REPORT_TOKEN or
// BLOXITY_GAME_ID is unset.
export async function reportLeaderboard(scores: ScoreRow[]): Promise<ReportResult> {
  const game = process.env.BLOXITY_GAME_ID;
  const token = process.env.BLOXITY_REPORT_TOKEN;
  if (!game || !token) return { ok: true, skipped: true, summary: "not configured" };
  if (!scores.length) return { ok: true, skipped: true, summary: "nothing to report" };
  const r = await post(`/v1/leaderboards/hosted/${encodeURIComponent(game)}/report`, { boards: BLOXITY_BOARDS, scores }, token);
  if (!r) return { ok: false, summary: "request failed" };
  const ok = r.status >= 200 && r.status < 300;
  let detail = "";
  try {
    detail = JSON.stringify(r.data)?.slice(0, 200) ?? "";
  } catch {
    // ignore
  }
  return { ok, summary: `HTTP ${r.status} ${detail}` };
}

// POST /v1/ads/reward/verify: true only when the answer says `valid === true`.
export async function verifyAdReward(rewardToken: string): Promise<boolean> {
  if (typeof rewardToken !== "string" || !rewardToken || rewardToken.length > AD_TOKEN_MAX_LEN) return false;
  const r = await post("/v1/ads/reward/verify", { gameSlug: gameSlug(), rewardToken });
  return r?.data?.valid === true;
}
