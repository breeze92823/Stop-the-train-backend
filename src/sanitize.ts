import {
  CURRENCY_MAX, REBIRTHS_MAX, PLAY_SECONDS_MAX, LEVEL_KINDS_MAX, LEVEL_MAX, UNIX_S_MAX, DAILY_DAY_MAX, ID_PATTERN,
} from "./constants.js";
import type { PlayerDoc } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Upgrade levels { id: int }: slug ids, whole non-negative levels, bounded kinds.
export function sanitizeLevels(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [id, n] of Object.entries(raw)) {
    if (Object.keys(out).length >= LEVEL_KINDS_MAX) break;
    if (isId(id) && finite(n)) out[id] = clampInt(n, LEVEL_MAX);
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.coins)) out.coins = clampNum(raw.coins, CURRENCY_MAX);
  if (finite(raw.power)) out.power = clampNum(raw.power, CURRENCY_MAX);
  if (finite(raw.luck)) out.luck = clampNum(raw.luck, CURRENCY_MAX);
  if (finite(raw.multiplier)) out.multiplier = clampNum(raw.multiplier, CURRENCY_MAX);
  if (finite(raw.powerMult)) out.powerMult = clampNum(raw.powerMult, CURRENCY_MAX, 1);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (finite(raw.breaks)) out.breaks = clampInt(raw.breaks, CURRENCY_MAX);
  if (finite(raw.robux)) out.robux = clampInt(raw.robux, CURRENCY_MAX);
  if (finite(raw.strength)) out.strength = clampInt(raw.strength, CURRENCY_MAX);
  if (raw.levels !== undefined) out.levels = sanitizeLevels(raw.levels);
  if (finite(raw.dailyAt)) out.dailyAt = clampInt(raw.dailyAt, UNIX_S_MAX);
  if (finite(raw.dailyDay)) out.dailyDay = clampInt(raw.dailyDay, DAILY_DAY_MAX);
  if (finite(raw.chestAt)) out.chestAt = clampInt(raw.chestAt, UNIX_S_MAX);
  if (finite(raw.updateEnds)) out.updateEnds = clampInt(raw.updateEnds, UNIX_S_MAX);
  if (typeof raw.seeded === "boolean") out.seeded = raw.seeded;
  if (typeof raw.muted === "boolean") out.muted = raw.muted;
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);
  return out;
}
