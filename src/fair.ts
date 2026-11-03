import { BAYS, FAIR, TRAIN_TABLE } from "./constants.js";

// Fair trains: the numbers the shared round (round.ts) sizes and pays its trains with. Pure functions,
// mirrored by the frontend's fair.js for the offline round.

// HP of the best vehicle a player with `power` Strength can lift (0 below the first bay).
export function bestHp(power: number): number {
  let best = 0;
  for (const [req, mult] of BAYS) if (power >= req) best = Math.max(best, req * mult);
  return best;
}

// One load of a player: the best vehicle x the Carry level. A room's power is the sum of these.
export const parkHp = (power: number, carry: number) =>
  bestHp(power) * Math.min(FAIR.carryMax, Math.max(1, Math.floor(carry)));

// HP x this for a ladder step: up 25% a step, down 15% a step, never under the floor.
export function ladderK(step: number): number {
  const { up, down, floor } = FAIR.ladder;
  return step >= 0 ? 1 + up * step : Math.max(floor, 1 + down * step);
}

// A new train's spread from one random number: harder (challenge), easier or plain.
export function spreadK(r: number): number {
  const s = FAIR.spread;
  if (r < s.up) return s.upK;
  if (r > 1 - s.down) return s.downK;
  return 1;
}

// The tier whose HP is nearest on a log scale: it gives the train its name and look.
export function tierFor(hp: number): number {
  let best = 0;
  for (let i = 1; i < TRAIN_TABLE.length; i++) {
    if (Math.abs(Math.log(hp / TRAIN_TABLE[i].hp)) < Math.abs(Math.log(hp / TRAIN_TABLE[best].hp))) best = i;
  }
  return best;
}

// Coins for stopping a train of `hp`: the tiers' rewards joined on a log-log line, so a bigger train
// always pays more; past either end the end tier's coins-per-HP.
export function rewardFor(hp: number): number {
  const first = TRAIN_TABLE[0];
  const last = TRAIN_TABLE[TRAIN_TABLE.length - 1];
  if (hp <= first.hp) return Math.round((first.reward / first.hp) * hp);
  if (hp >= last.hp) return Math.round((last.reward / last.hp) * hp);
  let i = 0;
  while (TRAIN_TABLE[i + 1].hp < hp) i++;
  const a = TRAIN_TABLE[i];
  const b = TRAIN_TABLE[i + 1];
  const k = Math.log(hp / a.hp) / Math.log(b.hp / a.hp);
  return Math.round(Math.exp(Math.log(a.reward) + k * Math.log(b.reward / a.reward)));
}

// The train for a room: HP from its power, the ladder step and the spread; its tier and reward follow.
export function sizeTrain(roomPower: number, step: number, spread: number) {
  const hp = Math.max(1, Math.round(Math.max(FAIR.minHp, roomPower * FAIR.targetRatio) * ladderK(step) * spread));
  return { idx: tierFor(hp), hp, reward: rewardFor(hp) };
}

// The coins multiplier of a win streak (`streak` trains already stopped in a row).
export const streakK = (streak: number) => 1 + Math.min(FAIR.streak.max, FAIR.streak.per * Math.max(0, streak));

// How much of a train of `maxHp` one player's hits may count for while others have vehicles in the
// pass: everything but the room left for them, which is what they can be asked for (teamShare of
// their trips x power) but never more than they actually brought (`othersParked`), so their
// vehicles always count and a capped player never loses the team a train it could stop. Infinity alone.
export function damageCap(maxHp: number, othersPower: number, othersParked: number, others: number): number {
  if (others <= 0) return Infinity;
  const owed = Math.min(FAIR.teamShare * FAIR.trips * othersPower, othersParked);
  return Math.max(FAIR.damageCap * maxHp, maxHp - owed);
}
