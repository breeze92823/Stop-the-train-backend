import { CARRY_VARIANTS } from "./presence.js";
import { DEFAULT_WORLD, ID_PATTERN, ROUND, TRAIN_TABLE, type WorldId } from "./constants.js";

// The shared round: one rail and one train for a world of the room. The server owns the clock, the
// parked vehicles and the train's position and HP, and tells every client in that world what happened;
// each client only draws it (rigid-body piles and wrecks stay local and cosmetic).
// Messages out (all through `emit`): `round` snapshot (join / world change / train start), `railAdd`,
// `trainTick`, `hit`, `derail`, `gone`.

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
  idx = 0; // TRAIN_TABLE index of the current train: the first is always beatable
  hp: number = TRAIN_TABLE[0].hp;
  back = false; // this train got through last time
  doubled = true;
  endsAt: number; // ms: end of the countdown / wreck
  head = 0;
  speed = 0;
  target = 0;
  length = 0;
  vehicles = new Map<string, RailVehicle>();
  seeded = false;
  private hitBy = new Set<string>();
  private lastSync = 0;

  constructor(
    private emit: Emit,
    private now: () => number = Date.now,
    private rng: () => number = Math.random,
    private world: WorldId = DEFAULT_WORLD,
  ) {
    this.endsAt = now() + ROUND.firstCountdown * 1000;
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
      back: this.back,
      doubled: this.doubled,
      left: this.phase === "run" ? 0 : Math.max(0, (this.endsAt - this.now()) / 1000),
      head: this.head,
      speed: this.speed,
      seeded: this.seeded,
      rail: [...this.vehicles.values()].map((v) => ({ id: v.id, by: v.by, spec: v.spec, x: v.x, halfLen: v.halfLen })),
    };
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

  private pickTrain() {
    const total = TRAIN_TABLE.reduce((a, t) => a + t.weight, 0);
    let r = this.rng() * total;
    for (let i = 0; i < TRAIN_TABLE.length; i++) {
      r -= TRAIN_TABLE[i].weight;
      if (r <= 0) return i;
    }
    return 0;
  }

  private startTrain() {
    const t = this.train;
    this.phase = "run";
    this.speed = this.target = t.speed;
    this.head = ROUND.mouth + t.speed * ROUND.approachSeconds;
    this.length = ROUND.locoLength + ROUND.gap + t.wagons * (ROUND.wagonLength + ROUND.gap);
    this.hitBy.clear();
    this.lastSync = 0;
    this.emit("round", this.snapshot());
  }

  // The eastmost vehicle the train's nose has reached, if any.
  private nextAt(front: number): RailVehicle | null {
    let best: RailVehicle | null = null;
    for (const v of this.vehicles.values()) if (v.x + v.halfLen >= front - 0.2 && (!best || v.x > best.x)) best = v;
    return best;
  }

  private endRun(result: "stopped" | "through") {
    this.idx = this.pickTrain();
    this.hp = this.train.hp;
    this.back = false;
    this.doubled = this.rng() < ROUND.doubleChance;
    this.phase = "countdown";
    this.endsAt = this.now() + ROUND.countdown * 1000;
    this.emit("gone", { result, ...this.snapshot() });
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
    this.head -= this.speed * dt;
    let v = this.nextAt(this.head);
    while (v) {
      const damage = Math.min(v.spec.hp, this.hp);
      this.hp = Math.max(0, this.hp - v.spec.hp);
      const ratio = Math.min(1, v.spec.hp / Math.max(1, spec.hp * 0.25));
      this.speed *= 1 - 0.1 - 0.16 * ratio;
      this.target = spec.speed * (0.48 + 0.52 * (this.hp / spec.hp));
      this.vehicles.delete(v.id);
      if (v.by) this.hitBy.add(v.by);
      this.emit("hit", { id: v.id, by: v.by, damage, hp: this.hp, speed: this.speed });
      if (this.hp <= 0) {
        this.phase = "wreck";
        this.endsAt = t + ROUND.wreckSeconds * 1000;
        this.emit("derail", { idx: this.idx, contributors: [...this.hitBy] });
        return;
      }
      v = this.nextAt(this.head);
    }
    if (this.head + this.length < -ROUND.mouth - 6) return this.endRun("through");
    if (t - this.lastSync >= ROUND.syncEveryMs) {
      this.lastSync = t;
      this.emit("trainTick", { head: this.head, speed: this.speed });
    }
  }
}
