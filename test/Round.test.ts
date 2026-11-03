import assert from "assert";

import { FAIR, ROUND, TRAIN_TABLE } from "../src/constants.js";
import { bestHp, ladderK, parkHp, rewardFor, sizeTrain, tierFor } from "../src/fair.js";
import { Round, type Member } from "../src/round.js";

const spec = (hp: number) => ({ type: "sedan", paint: "#ff0000", variant: "normal", hp });

// `members` is the room as round.ts sees it; rng 0.5 = a plain train (no spread, no X2).
function setup(members: Member[] = []) {
  let now = 1_000_000;
  const log: { type: string; payload: any }[] = [];
  const room = { members };
  const round = new Round((type, payload) => log.push({ type, payload }), () => now, () => 0.5, undefined, () => room.members);
  const advance = (seconds: number, step = 0.05) => {
    for (let t = 0; t < seconds; t += step) {
      now += step * 1000;
      round.tick(step);
    }
  };
  // Runs the countdown out; the train is sized as it leaves.
  const start = () => {
    advance(Math.max(0, (round.endsAt - now) / 1000) + 0.1);
    assert.strictEqual(round.phase, "run");
  };
  const last = (type: string) => [...log].reverse().find((l) => l.type === type)?.payload;
  // The whole reward of the running train (the first one pays X2).
  const total = () => round.reward * (round.doubled ? 2 : 1);
  return { round, log, room, advance, start, last, total, jump: (ms: number) => (now += ms) };
}
// Lets a running train hit everything and finish its pass (wreck included).
const finishPass = (s: ReturnType<typeof setup>) => s.advance(ROUND.wreckSeconds + 25);

describe("fair trains", () => {
  it("knows what a player can lift", () => {
    assert.strictEqual(bestHp(1), 0);
    assert.strictEqual(bestHp(600), 600);
    assert.strictEqual(bestHp(2000), 9000, "the emerald Hyperion: 1500 x 6");
    assert.strictEqual(parkHp(600, 3), 1800);
    assert.strictEqual(parkHp(600, 1e9), 600 * FAIR.carryMax);
  });

  it("sizes a train to the room, with a tier and a reward that grow with its HP", () => {
    const t = sizeTrain(1000, 0, 1);
    assert.strictEqual(t.hp, Math.round(1000 * FAIR.targetRatio));
    assert.strictEqual(sizeTrain(0, 0, 1).hp, FAIR.minHp);
    assert.strictEqual(tierFor(TRAIN_TABLE[4].hp), 4);
    for (let hp = 10; hp < 1e13; hp *= 1.7) assert.ok(rewardFor(hp * 1.7) > rewardFor(hp), `reward grows past ${hp}`);
    assert.strictEqual(rewardFor(TRAIN_TABLE[3].hp), TRAIN_TABLE[3].reward);
  });

  it("keeps the ladder between its floor and its top", () => {
    assert.strictEqual(ladderK(0), 1);
    assert.strictEqual(ladderK(2), 1 + 2 * FAIR.ladder.up);
    assert.strictEqual(ladderK(FAIR.ladder.min), FAIR.ladder.floor);
  });
});

describe("shared Round", () => {
  it("adds vehicles from different players to one rail and rejects bad ones", () => {
    const { round, log } = setup();
    assert.ok(round.park("a", { id: "v1", spec: spec(5000), x: 10, halfLen: 2, from: null }));
    assert.ok(round.park("b", { id: "v2", spec: spec(7000), x: 20, halfLen: 2, from: { x: 1, y: 2, z: 3 } }));
    assert.strictEqual(round.vehicles.size, 2);
    assert.ok(!round.park("a", { id: "v1", spec: spec(5000), x: 10, halfLen: 2 }), "duplicate id");
    assert.ok(!round.park("a", { id: "v3", spec: spec(-1), x: 10, halfLen: 2 }), "bad hp");
    assert.ok(!round.park("a", { id: "v4 x", spec: spec(10), x: 10, halfLen: 2 }), "bad id");
    assert.strictEqual(log.filter((l) => l.type === "railAdd").length, 2);
  });

  it("caps one player's vehicles", () => {
    const { round } = setup();
    for (let i = 0; i < ROUND.perPlayerCap; i++) assert.ok(round.park("a", { id: `v${i}`, spec: spec(10), x: i, halfLen: 2 }));
    assert.ok(!round.park("a", { id: "over", spec: spec(10), x: 0, halfLen: 2 }));
    assert.ok(round.park("b", { id: "other", spec: spec(10), x: 0, halfLen: 2 }));
  });

  it("seeds once", () => {
    const { round } = setup();
    round.seed([{ spec: spec(10), x: 3, halfLen: 2 }]);
    round.seed([{ spec: spec(10), x: 4, halfLen: 2 }]);
    assert.strictEqual(round.vehicles.size, 1);
  });

  it("sizes the train to the players there as it leaves", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    s.room.members = [{ sid: "a", parkHp: 1000 }, { sid: "b", parkHp: 3000 }];
    s.start();
    assert.strictEqual(s.round.maxHp, Math.round(4000 * FAIR.targetRatio));
    assert.strictEqual(s.last("round").maxHp, s.round.maxHp);
    assert.strictEqual(s.round.underdog, "a");
  });

  it("sums everyone's HP against the train, derails it and splits the reward by damage", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }, { sid: "b", parkHp: 1000 }]);
    s.start();
    const need = s.round.maxHp;
    s.round.park("a", { id: "v1", spec: spec(need * 0.6), x: 10, halfLen: 2 });
    s.round.park("b", { id: "v2", spec: spec(need * 0.4), x: 20, halfLen: 2 });
    s.advance(9);
    assert.strictEqual(s.log.filter((l) => l.type === "hit").length, 2);
    const derail = s.last("derail");
    assert.deepStrictEqual(derail.contributors.sort(), ["a", "b"]);
    const reward = s.total();
    assert.ok(Math.abs(derail.pay.a - reward * 0.6) <= 2, `a gets 60%: ${derail.pay.a}`);
    assert.ok(Math.abs(derail.pay.b - reward * 0.4) <= 2, `b gets 40%: ${derail.pay.b}`);
    assert.strictEqual(s.round.phase, "wreck");
    assert.strictEqual(s.round.streak, 1);
    assert.strictEqual(s.round.step, 1);
  });

  it("gives anyone who hit at least the reward floor, and the underdog a bonus", () => {
    const s = setup([{ sid: "a", parkHp: 10 }, { sid: "b", parkHp: 1000 }]);
    s.start();
    const need = s.round.maxHp;
    // b's cap leaves what a can be asked for (half of a's trips) to a, who brings it.
    s.round.park("a", { id: "v1", spec: spec(20), x: 30, halfLen: 2 });
    s.round.park("b", { id: "v2", spec: spec(need), x: 10, halfLen: 2 });
    s.advance(9);
    const derail = s.last("derail");
    const reward = s.total();
    assert.strictEqual(derail.pay.a, Math.round(reward * FAIR.rewardFloor * (1 + FAIR.underdog)));
  });

  it("halves an overkill player's pay", () => {
    const s = setup([{ sid: "a", parkHp: 100 }]);
    s.start();
    s.round.park("a", { id: "v1", spec: spec(s.round.maxHp * (FAIR.overkill.ratio + 1)), x: 10, halfLen: 2 });
    s.advance(9);
    assert.strictEqual(s.last("derail").pay.a, Math.round(s.total() * FAIR.overkill.cut));
  });

  it("does not cap a player alone", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    s.start();
    s.round.park("a", { id: "v1", spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
    s.advance(9);
    assert.ok(s.last("derail"));
  });

  it("keeps room for a teammate's vehicles, without costing the team the train", () => {
    const s = setup([{ sid: "a", parkHp: 5000 }, { sid: "b", parkHp: 5000 }]);
    s.start();
    const need = s.round.maxHp;
    s.round.park("a", { id: "v1", spec: spec(need * 2), x: 30, halfLen: 2 }); // hit first
    s.round.park("b", { id: "v2", spec: spec(need * 0.3), x: 10, halfLen: 2 });
    s.advance(30);
    const first = s.log.find((l) => l.type === "hit")!.payload;
    assert.ok(first.capped, "a's hit was capped");
    assert.strictEqual(first.damage, Math.round(need - need * 0.3), "a leaves b's share");
    const derail = s.last("derail");
    assert.ok(derail, "b's vehicle finishes it");
    assert.ok(derail.pay.b >= Math.round(s.total() * 0.3) - 1, "b is paid for its 30%");
  });

  it("caps a player at the damage cap when the teammate brought plenty", () => {
    const s = setup([{ sid: "a", parkHp: 1e6 }, { sid: "b", parkHp: 1e6 }]);
    s.start();
    const need = s.round.maxHp;
    s.round.park("a", { id: "v1", spec: spec(need), x: 30, halfLen: 2 });
    s.round.park("b", { id: "v2", spec: spec(need), x: 10, halfLen: 2 });
    s.advance(30);
    const first = s.log.find((l) => l.type === "hit")!.payload;
    assert.strictEqual(first.damage, Math.round(Math.max(FAIR.damageCap * need, need - FAIR.teamShare * FAIR.trips * 1e6)));
    assert.ok(s.last("derail"));
  });

  it("lets the train through when HP is short, steps the ladder down and reports how close it was", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    s.start();
    s.round.park("a", { id: "v1", spec: spec(s.round.maxHp / 2), x: 10, halfLen: 2 });
    s.advance(30);
    const gone = s.last("gone");
    assert.strictEqual(gone.result, "through");
    assert.ok(Math.abs(gone.hpLeft - 0.5) < 0.01, `hpLeft ${gone.hpLeft}`);
    assert.strictEqual(s.round.step, -FAIR.ladder.loss);
    assert.strictEqual(s.round.losses, 1);
    assert.strictEqual(s.round.maxHp, Math.round(1000 * FAIR.targetRatio * ladderK(-FAIR.ladder.loss)));
    assert.strictEqual(s.round.phase, "countdown");
  });

  it("sends a x2 COMEBACK train after enough losses, and the ladder stops at its floor", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    for (let i = 0; i < FAIR.comebackAfter + 2; i++) {
      s.start();
      s.advance(30);
    }
    assert.ok(s.round.comeback);
    assert.ok(s.round.doubled);
    assert.strictEqual(s.round.step, FAIR.ladder.min);
    // A win ends it.
    s.start();
    s.round.park("a", { id: "w", spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
    finishPass(s);
    assert.ok(!s.round.comeback);
    assert.strictEqual(s.round.losses, 0);
  });

  it("pays a streak bonus on later wins", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    for (let i = 0; i < 3; i++) {
      s.start();
      s.round.park("a", { id: `w${i}`, spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
      finishPass(s);
    }
    assert.strictEqual(s.round.streak, 3);
    s.start();
    const reward = s.round.reward;
    s.round.park("a", { id: "w9", spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
    s.advance(9);
    assert.strictEqual(s.last("derail").pay.a, Math.round(reward * (1 + 3 * FAIR.streak.per)));
  });

  it("does not punish an empty world, and resets the ladder after it idles", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    s.start();
    s.round.park("a", { id: "w", spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
    finishPass(s);
    assert.strictEqual(s.round.step, 1);
    s.room.members = [];
    s.start();
    s.advance(30);
    assert.strictEqual(s.round.step, 1, "nobody lost that one");
    s.jump(FAIR.ladder.idleResetMs);
    s.room.members = [{ sid: "a", parkHp: 1000 }];
    s.start();
    assert.strictEqual(s.round.step, 0);
    assert.strictEqual(s.round.streak, 0);
  });

  it("pays everyone a room milestone", () => {
    const s = setup([{ sid: "a", parkHp: 1000 }]);
    s.round.stopped = FAIR.milestone.every - 1;
    s.start();
    s.round.park("a", { id: "w", spec: spec(s.round.maxHp), x: 10, halfLen: 2 });
    s.advance(9);
    const m = s.last("derail").milestone;
    assert.strictEqual(m.n, FAIR.milestone.every);
    assert.ok(m.coins > 0);
  });
});
