import { AVATAR_MAX_LEN, EMOTE_ID_PATTERN, ID_PATTERN, POSE_BOUNDS } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";

// Presence: what the other clients need to draw a player in the world. Relayed through the
// roster, only bounded / re-serialised here -- client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

export const VY_MAX = 200;
export const BENCH_MAX = 63;
export const CARRY_MAX_LEN = 120;
export const CARRY_VARIANTS = ["normal", "golden", "emerald"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

// `pose` { x, y, z, yaw, speed, grounded, vy }: position in metres (world within +-POSE_BOUNDS.pos).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS.pos;
  if (finite(m.x)) p.x = clamp(m.x, -b, b);
  if (finite(m.y)) p.y = clamp(m.y, -b, b);
  if (finite(m.z)) p.z = clamp(m.z, -b, b);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, POSE_BOUNDS.speed);
  if (typeof m.grounded === "boolean") p.grounded = m.grounded;
  if (finite(m.vy)) p.vy = clamp(m.vy, -VY_MAX, VY_MAX);
}

// `carry` { spec: { type, paint, variant } | null } -> the stored string: sanitized fields,
// re-serialised ("" = nothing carried). Never the raw input.
export function carryString(spec: unknown): string {
  if (!spec || typeof spec !== "object") return "";
  const s = spec as Record<string, unknown>;
  if (!isId(s.type)) return "";
  const paint = typeof s.paint === "string" && HEX.test(s.paint) ? s.paint.toLowerCase() : "#ffffff";
  const variant = (CARRY_VARIANTS as readonly unknown[]).includes(s.variant) ? (s.variant as string) : "normal";
  const out = JSON.stringify({ type: s.type, paint, variant });
  return out.length <= CARRY_MAX_LEN ? out : "";
}
export function applyCarry(p: PlayerState, msg: unknown): void {
  p.carry = carryString((msg as { spec?: unknown })?.spec);
}

// `train` { bench: int 0..63 | -1, rep: 0..1 }: -1 stops training.
export function applyTrain(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  if (!finite(m.bench) || !Number.isInteger(m.bench) || m.bench < 0 || m.bench > BENCH_MAX) {
    p.bench = -1;
    p.benchRep = 0;
    return;
  }
  p.bench = m.bench;
  p.benchRep = finite(m.rep) ? clamp(m.rep, 0, 1) : 0;
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
}

// `emote` { id }: "" stops. Every accepted message bumps emoteSeq so a repeated id replays.
export function applyEmote(p: PlayerState, msg: unknown): void {
  const id = (msg as { id?: unknown })?.id;
  if (id !== "" && !(typeof id === "string" && EMOTE_ID_PATTERN.test(id))) return;
  p.emote = id as string;
  p.emoteSeq = (p.emoteSeq + 1) >>> 0;
}
