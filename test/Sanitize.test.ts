import assert from "assert";

import { CURRENCY_MAX, LEVEL_KINDS_MAX, LEVEL_MAX, REBIRTHS_MAX, UNIX_S_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ coins: 1e40, power: -5, luck: NaN, rebirths: 1e12, breaks: 3.7, robux: 9.9, seeded: "yes", hack: "x" })!;
    assert.strictEqual(out.coins, CURRENCY_MAX);
    assert.strictEqual(out.power, 0);
    assert.strictEqual(out.luck, undefined);
    assert.strictEqual(out.rebirths, REBIRTHS_MAX);
    assert.strictEqual(out.breaks, 3);
    assert.strictEqual(out.robux, 9);
    assert.strictEqual(out.seeded, undefined);
    assert.ok(!("hack" in out));
  });

  it("keeps powerMult at 1 or more", () => {
    assert.strictEqual(sanitizeProgress({ powerMult: 0.2 })!.powerMult, 1);
    assert.strictEqual(sanitizeProgress({ powerMult: 2.5 })!.powerMult, 2.5);
    assert.strictEqual(sanitizeProgress({ multiplier: 3, seeded: true })!.seeded, true);
  });

  it("bounds levels to slug ids, ints and a bounded count", () => {
    const out = sanitizeProgress({ levels: { magnet: 3.9, carry: -2, "bad id": 1, fuse: "x", walkspeed: 1e12 } })!;
    assert.deepStrictEqual(out.levels, { magnet: 3, carry: 0, walkspeed: LEVEL_MAX });
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`u${i}`, 1]));
    assert.strictEqual(Object.keys(sanitizeProgress({ levels: many })!.levels!).length, LEVEL_KINDS_MAX);
    assert.deepStrictEqual(sanitizeProgress({ levels: "x" })!.levels, {});
  });

  it("keeps the collection book to known trains and whole counts", () => {
    const out = sanitizeProgress({ trainsStopped: { common: 3.7, epic: -1, made_up: 5, rare: "x" } })!;
    assert.deepStrictEqual(out.trainsStopped, { common: 3, epic: 0 });
  });

  it("bounds the timestamps and the daily streak", () => {
    const out = sanitizeProgress({ dailyAt: -1, chestAt: 1e15, updateEnds: 1700000000.7, dailyDay: 4.2 })!;
    assert.deepStrictEqual([out.dailyAt, out.chestAt, out.updateEnds, out.dailyDay], [0, UNIX_S_MAX, 1700000000, 4]);
  });
});
