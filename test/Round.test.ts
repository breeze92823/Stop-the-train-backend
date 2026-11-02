import assert from "assert";

import { ROUND, TRAIN_TABLE } from "../src/constants.js";
import { Round } from "../src/round.js";

const spec = (hp: number) => ({ type: "sedan", paint: "#ff0000", variant: "normal", hp });

function setup() {
  let now = 1_000_000;
  const log: { type: string; payload: any }[] = [];
  const round = new Round((type, payload) => log.push({ type, payload }), () => now, () => 0.5);
  const advance = (seconds: number, step = 0.05) => {
    for (let t = 0; t < seconds; t += step) {
      now += step * 1000;
      round.tick(step);
    }
  };
  return { round, log, advance, jump: (ms: number) => (now += ms) };
}

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

  it("sums everyone's HP against the train and derails it", () => {
    const { round, log, advance } = setup();
    const need = TRAIN_TABLE[0].hp;
    round.park("a", { id: "v1", spec: spec(need / 2 + 1), x: 10, halfLen: 2 });
    round.park("b", { id: "v2", spec: spec(need / 2 + 1), x: 20, halfLen: 2 });
    advance(ROUND.firstCountdown + 1);
    assert.strictEqual(round.phase, "run");
    advance(9);
    const hits = log.filter((l) => l.type === "hit");
    assert.strictEqual(hits.length, 2);
    const derail = log.find((l) => l.type === "derail")!;
    assert.deepStrictEqual(derail.payload.contributors.sort(), ["a", "b"]);
    assert.strictEqual(round.phase, "wreck");
  });

  it("lets the train through when HP is short and sends a fresh train", () => {
    const { round, log, advance } = setup();
    round.park("a", { id: "v1", spec: spec(1000), x: 10, halfLen: 2 });
    advance(ROUND.firstCountdown + 1);
    advance(12);
    assert.ok(log.some((l) => l.type === "hit"));
    advance(10);
    const gone = log.find((l) => l.type === "gone")!;
    assert.strictEqual(gone.payload.result, "through");
    assert.strictEqual(round.hp, round.train.hp);
    assert.ok(!round.back);
    assert.strictEqual(round.phase, "countdown");
  });
});
