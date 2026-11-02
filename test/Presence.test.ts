import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { AVATAR_MAX_LEN, POSE_BOUNDS } from "../src/constants.js";
import { carryString, VY_MAX } from "../src/presence.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("takes the pose and look from the join options", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, {
      userId: "guest-a",
      pose: { x: 3, y: 0.5, z: -12, yaw: Math.PI, speed: 4, grounded: false, vy: -9 },
      avatar: '{"equipped":{}}',
    });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    assert.deepStrictEqual([p.x, p.y, p.z, p.speed, p.grounded, p.vy], [3, 0.5, -12, 4, false, -9]);
    assert.ok(Math.abs(Math.abs(p.yaw) - Math.PI) < 1e-5);
    assert.strictEqual(p.avatar, '{"equipped":{}}');
    assert.strictEqual(p.bench, -1);
  });

  it("bounds poses and relays them to the others", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    await sleep(50);
    a.send("pose", { x: 1e9, y: "high", z: -1e12, yaw: 7, speed: -3, grounded: "no", vy: 1e6 });
    a.send("setAvatar", { avatar: "x".repeat(AVATAR_MAX_LEN + 1) });
    await sleep(100);
    const p = room.state.players.get(a.sessionId)!;
    assert.strictEqual(p.x, POSE_BOUNDS.pos);
    assert.strictEqual(p.y, 0, "a non-number is ignored");
    assert.strictEqual(p.z, -POSE_BOUNDS.pos);
    assert.ok(Math.abs(p.yaw - Math.atan2(Math.sin(7), Math.cos(7))) < 1e-5);
    assert.strictEqual(p.speed, 0);
    assert.strictEqual(p.grounded, true, "a non-boolean is ignored");
    assert.strictEqual(p.vy, VY_MAX);
    assert.strictEqual(p.avatar, "");
    const seen = (b.state as any).players.get(a.sessionId);
    assert.strictEqual(seen.x, POSE_BOUNDS.pos);
  });

  it("sanitises and re-serialises the carried vehicle", async () => {
    assert.strictEqual(carryString(null), "");
    assert.strictEqual(carryString({ type: "Bad Id!" }), "");
    assert.deepStrictEqual(JSON.parse(carryString({ type: "bus", paint: "#FFAA00", variant: "golden", evil: 1 })), { type: "bus", paint: "#ffaa00", variant: "golden" });
    assert.deepStrictEqual(JSON.parse(carryString({ type: "car", paint: "red", variant: "rainbow" })), { type: "car", paint: "#ffffff", variant: "normal" });

    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    a.send("carry", { spec: { type: "bus", paint: "#00ff00", variant: "emerald" } });
    await sleep(60);
    assert.strictEqual(p.carry, '{"type":"bus","paint":"#00ff00","variant":"emerald"}');
    assert.ok(p.carry.length <= 120);
    a.send("carry", { spec: null });
    await sleep(60);
    assert.strictEqual(p.carry, "");
  });

  it("bounds training and relays emotes with a replay counter", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;
    a.send("train", { bench: 5, rep: 3 });
    await sleep(50);
    assert.deepStrictEqual([p.bench, p.benchRep], [5, 1]);
    a.send("train", { bench: 64, rep: 0.5 });
    await sleep(50);
    assert.deepStrictEqual([p.bench, p.benchRep], [-1, 0]);
    a.send("train", { bench: 2, rep: 0.25 });
    a.send("train", { bench: -1, rep: 0 });
    await sleep(50);
    assert.strictEqual(p.bench, -1);

    a.send("emote", { id: "wave" });
    await sleep(50);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["wave", 1]);
    a.send("emote", { id: "wave" });
    a.send("emote", { id: "bad id!" });
    await sleep(50);
    assert.deepStrictEqual([p.emote, p.emoteSeq], ["wave", 2], "a repeat replays, a bad id is ignored");
    a.send("emote", { id: "" });
    await sleep(50);
    assert.strictEqual(p.emote, "");
  });
});
