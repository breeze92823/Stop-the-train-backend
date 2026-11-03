import { CARRY_VARIANTS } from "./presence.js";
import { DEFAULT_WORLD, FAIR, ID_PATTERN, ROUND, TRAIN_TABLE, type WorldId } from "./constants.js";
import { damageCap, sizeTrain, spreadK, streakK } from "./fair.js";

// The shared round: one rail and one train for a world of the room. The server owns the clock, the
// parked vehicles and the train's position and HP, and tells every client in that world what happened;
// each client only draws it (rigid-body piles and wrecks stay local and cosmetic).
// Messages out (all through `emit`): `round` snapshot (join / world change / train start), `railAdd`,
// `trainTick`, `hit`, `derail`, `gone`.
// Fair trains (fair.ts): every train is sized to the power of the players in the world, a ladder makes
// the next one harder after a win and easier after a loss, one player's damage is capped while others
// have vehicles in the pass, and the reward is split by the damage each player did.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const HEX = /^#[0-9a-fA-F]{6}$/;

export interface VehicleSpec {
  type: string;
  paint: string;
  variant: string;
  hp: number;
}
export interface RailVehicle {
  id: string;
  by: string; // sessionId, "" for the seeded ones
  spec: VehicleSpec;
  x: number;
  halfLen: number;
}
// A player in this world and their load (fair.ts parkHp). Players with hidden tabs are left out.
export interface Member {
  sid: string;
  parkHp: number;
}
type Emit = (type: string, payload: unknown) => void;
export type Phase = "countdown" | "run" | "wreck";

export function cleanSpec(raw: unknown): VehicleSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.type !== "string" || !ID_PATTERN.test(s.type)) return null;
  if (!finite(s.hp) || s.hp <= 0) return null;
  return {
    type: s.type,
    paint: typeof s.paint === "string" && HEX.test(s.paint) ? s.paint.toLowerCase() : "#ffffff",
    variant: (CARRY_VARIANTS as readonly unknown[]).includes(s.variant) ? (s.variant as string) : "normal",
    hp: Math.min(Math.floor(s.hp), ROUND.hpMax),
  };
}

export class Round {
  phase: Phase = "countdown";
  idx = 0; // TRAIN_TABLE index of the current train's look
  hp = 0;
  maxHp = 0; // this train's HP, sized to the room (fair.ts)
  reward = 0; // coins for stopping it, before X2 and the streak
  back = false; // this train got through last time
  doubled = true;
  endsAt: number; // ms: end of the countdown / wreck
  // -1: out of the east tunnel heading west, +1: out of the west tunnel heading east. Picked per train.
  dir: -1 | 1 = -1;
  head = 0; // x of the locomotive's nose; the train trails behind it, away from `dir`
  speed = 0;
  target = 0;
  length = 0;
  vehicles = new Map<string, RailVehicle>();
  seeded = false;
  // The ladder: step (-3..10) scales the next train, streak counts wins in a row, losses losses in a row.
  step = 0;
  streak = 0;
  losses = 0;
  comeback = false; // this train is the x2 COMEBACK train after FAIR.comebackAfter losses
  stopped = 0; // trains this world of the room has stopped (milestones)
  underdog = ""; // the weakest player of a room of 2+ (+50% coins)
  private spread = 1;
  private hitBy = new Set<string>();
  private damageBy = new Map<string, number>();
  private overkill = new Set<string>();
  private emptySince = 0;
  private lastSync = 0;

  constructor(
    private emit: Emit,
    private now: () => number = Date.now,
    private rng: () => number = Math.random,
    private world: WorldId = DEFAULT_WORLD,
    private members: () => Member[] = () => [],
  ) {
    this.endsAt = now() + ROUND.firstCountdown * 1000;
    this.dir = this.pickDir();
    this.size();
  }

  private pickDir(): -1 | 1 {
    return this.rng() < 0.5 ? 1 : -1;
  }

  get train() {
    return TRAIN_TABLE[this.idx];
  }

  snapshot() {
    return {
      world: this.world, // a client that has just changed world ignores the old one's last messages
      phase: this.phase,
      idx: this.idx,
      hp: this.hp,
      maxHp: this.maxHp,
      reward: this.reward,
      back: this.back,
      doubled: this.doubled,
      step: this.step,
      streak: this.streak,
      losses: this.losses,
      comeback: this.comeback,
      underdog: this.underdog,
      stopped: this.stopped,
      left: this.phase === "run" ? 0 : Math.max(0, (this.endsAt - this.now()) / 1000),
      dir: this.dir,
      head: this.head,
      speed: this.speed,
      seeded: this.seeded,
      rail: [...this.vehicles.values()].map((v) => ({ id: v.id, by: v.by, spec: v.spec, x: v.x, halfLen: v.halfLen })),
    };
  }

  // Sizes the coming train to the players in this world: their power x the ladder x this train's spread.
  private size() {
    const power = this.members().reduce((a, m) => a + m.parkHp, 0);
    const t = sizeTrain(power, this.step, this.spread);
    this.idx = t.idx;
    this.hp = this.maxHp = t.hp;
    this.reward = t.reward;
  }

  // A world nobody has played in for FAIR.ladder.idleResetMs starts the ladder again.
  private idleCheck(present: number) {
    const t = this.now();
    if (!present) {
      if (!this.emptySince) this.emptySince = t;
      return;
    }
    if (this.emptySince && t - this.emptySince >= FAIR.ladder.idleResetMs) {
      this.step = this.streak = this.losses = 0;
      this.comeback = false;
    }
    this.emptySince = 0;
  }

  // How much more damage `by`'s hits may count for in this pass (Infinity while no one else is in it).
  private capLeft(by: string): number {
    if (!by) return Infinity;
    // The others in this pass: what they already took off the train and what they still have on the rail.
    const parked = new Map<string, number>();
    for (const sid of this.hitBy) if (sid !== by) parked.set(sid, this.damageBy.get(sid) ?? 0);
    for (const v of this.vehicles.values()) if (v.by && v.by !== by) parked.set(v.by, (parked.get(v.by) ?? 0) + v.spec.hp);
    const power = new Map(this.members().map((m) => [m.sid, m.parkHp]));
    let othersPower = 0;
    let othersParked = 0;
    for (const [sid, hp] of parked) {
      othersPower += power.get(sid) ?? 0;
      othersParked += hp;
    }
    return Math.max(0, damageCap(this.maxHp, othersPower, othersParked, parked.size) - (this.damageBy.get(by) ?? 0));
  }

  // Coins per contributor (sessionId -> coins): the reward (X2, streak) split by damage, at least
  // FAIR.rewardFloor of it each, halved for overkill, +FAIR.underdog for the room's weakest player.
  private payouts(): Record<string, number> {
    const total = this.reward * (this.doubled ? 2 : 1) * streakK(this.streak);
    const pay: Record<string, number> = {};
    for (const sid of this.hitBy) {
      let k = Math.max(FAIR.rewardFloor, (this.damageBy.get(sid) ?? 0) / this.maxHp);
      if (this.overkill.has(sid)) k *= FAIR.overkill.cut;
      if (sid === this.underdog) k *= 1 + FAIR.underdog;
      pay[sid] = Math.round(total * k);
    }
    return pay;
  }

  private add(by: string, id: string, spec: VehicleSpec, x: number, halfLen: number, from: unknown): boolean {
    if (this.vehicles.size >= ROUND.railCap || this.vehicles.has(id)) return false;
    const v: RailVehicle = { id, by, spec, x: clamp(x, -ROUND.placeHalf, ROUND.placeHalf), halfLen: clamp(halfLen, 0.5, 8) };
    this.vehicles.set(id, v);
    let f: { x: number; y: number; z: number } | null = null;
    if (from && typeof from === "object") {
      const { x: fx, y: fy, z: fz } = from as Record<string, unknown>;
      if (finite(fx) && finite(fy) && finite(fz)) f = { x: clamp(fx, -400, 400), y: clamp(fy, -50, 100), z: clamp(fz, -400, 400) };
    }
    this.emit("railAdd", { id, by, spec, x: v.x, halfLen: v.halfLen, from: f });
    return true;
  }

  // `park` { id, spec, x, halfLen, from: {x,y,z} | null }. False when refused (the sender then drops its copy).
  park(by: string, msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    const spec = cleanSpec(m.spec);
    if (!spec || typeof m.id !== "string" || !ID_PATTERN.test(m.id) || !finite(m.x) || !finite(m.halfLen)) return false;
    let mine = 0;
    for (const v of this.vehicles.values()) if (v.by === by) mine++;
    if (mine >= ROUND.perPlayerCap) return false;
    return this.add(by, m.id, spec, m.x, m.halfLen, m.from);
  }

  // The first client into a brand-new room fills the rail so the first train has a target.
  seed(list: unknown): void {
    if (this.seeded || !Array.isArray(list)) return;
    this.seeded = true;
    list.slice(0, 12).forEach((m, i) => {
      const spec = cleanSpec(m?.spec);
      if (spec && finite(m?.x) && finite(m?.halfLen)) this.add("", `seed${i}`, spec, m.x, m.halfLen, null);
    });
  }

  private startTrain() {
    // Sized again as it leaves: players may have joined, left or grown during the countdown.
    const members = this.members();
    this.idleCheck(members.length);
    this.size();
    const t = this.train;
    this.phase = "run";
    this.speed = this.target = t.speed;
    this.head = -this.dir * (ROUND.mouth + t.speed * ROUND.approachSeconds);
    this.length = ROUND.locoLength + ROUND.gap + t.wagons * (ROUND.wagonLength + ROUND.gap);
    this.hitBy.clear();
    this.damageBy.clear();
    this.overkill.clear();
    this.underdog = "";
    if (members.length >= 2) {
      const sorted = [...members].sort((a, b) => a.parkHp - b.parkHp);
      if (sorted[0].parkHp < sorted[1].parkHp) this.underdog = sorted[0].sid;
    }
    this.lastSync = 0;
    this.emit("round", this.snapshot());
  }

  // The vehicle the train's nose has reached first along its way (eastmost for a westbound train), if any.
  private nextAt(front: number): RailVehicle | null {
    const d = this.dir;
    let best: RailVehicle | null = null;
    for (const v of this.vehicles.values()) {
      if (d * (v.x - d * v.halfLen) <= d * front + 0.2 && (!best || -d * v.x > -d * best.x)) best = v;
    }
    return best;
  }

  // A stopped train has already moved the ladder up (at the derail); one that got through moves it down,
  // unless nobody was there to lose it.
  private endRun(result: "stopped" | "through") {
    const hpLeft = this.maxHp > 0 ? this.hp / this.maxHp : 0;
    const present = this.members().length;
    if (result === "through" && present) {
      this.step = Math.max(FAIR.ladder.min, this.step - FAIR.ladder.loss);
      this.streak = 0;
      this.losses += 1;
    }
    this.idleCheck(present);
    this.comeback = this.losses >= FAIR.comebackAfter;
    this.spread = spreadK(this.rng());
    this.dir = this.pickDir();
    this.size();
    this.back = false;
    this.doubled = this.rng() < ROUND.doubleChance || this.comeback;
    this.phase = "countdown";
    this.endsAt = this.now() + ROUND.countdown * 1000;
    if (result === "stopped") this.vehicles.clear(); // a crashed train leaves a clean railway
    this.emit("gone", { result, hpLeft, ...this.snapshot() });
  }

  // The train is down: pay, climb the ladder, and count toward the room's milestones.
  private derail() {
    const pay = this.payouts();
    const total = this.reward * (this.doubled ? 2 : 1) * streakK(this.streak);
    this.streak += 1;
    this.losses = 0;
    this.step = Math.min(FAIR.ladder.max, this.step + FAIR.ladder.win);
    this.stopped += 1;
    const milestone =
      this.stopped % FAIR.milestone.every === 0 ? { n: this.stopped, coins: Math.round(total * FAIR.milestone.share) } : null;
    this.emit("derail", { idx: this.idx, contributors: [...this.hitBy], pay, streak: this.streak, step: this.step, milestone });
  }

  tick(dt: number): void {
    const t = this.now();
    if (this.phase === "countdown") {
      if (t >= this.endsAt) this.startTrain();
      return;
    }
    if (this.phase === "wreck") {
      if (t >= this.endsAt) this.endRun("stopped");
      return;
    }
    const spec = this.train;
    this.speed += Math.sign(this.target - this.speed) * Math.min(Math.abs(this.target - this.speed), ROUND.brake * dt);
    this.head += this.dir * this.speed * dt;
    let v = this.nextAt(this.head);
    while (v) {
      // Past its owner's cap a vehicle still crashes, but takes nothing off the train.
      const damage = Math.min(v.spec.hp, this.hp, this.capLeft(v.by));
      this.hp = Math.max(0, this.hp - damage);
      const ratio = Math.min(1, damage / Math.max(1, this.maxHp * 0.25));
      this.speed *= 1 - 0.1 - 0.16 * ratio;
      this.target = spec.speed * (0.48 + 0.52 * (this.hp / this.maxHp));
      this.vehicles.delete(v.id);
      if (v.by) {
        this.hitBy.add(v.by);
        this.damageBy.set(v.by, (this.damageBy.get(v.by) ?? 0) + damage);
        if (v.spec.hp > FAIR.overkill.ratio * this.maxHp) this.overkill.add(v.by);
      }
      this.emit("hit", { id: v.id, by: v.by, damage, capped: damage < Math.min(v.spec.hp, this.hp + damage), hp: this.hp, speed: this.speed });
      if (this.hp <= 0) {
        this.phase = "wreck";
        this.endsAt = t + ROUND.wreckSeconds * 1000;
        this.derail();
        return;
      }
      v = this.nextAt(this.head);
    }
    if (this.dir * this.head - this.length > ROUND.mouth + 6) return this.endRun("through");
    if (t - this.lastSync >= ROUND.syncEveryMs) {
      this.lastSync = t;
      this.emit("trainTick", { head: this.head, speed: this.speed });
    }
  }
}
