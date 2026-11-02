import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("shared rail over the room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("sends the round on join and shows one player's throw to the other", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const seenByA: any[] = [];
    a.onMessage("round", (m) => seenByA.push(m));
    a.onMessage("railAdd", (m) => seenByA.push(m));
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    const seenByB: any[] = [];
    b.onMessage("railAdd", (m) => seenByB.push(m));
    await sleep(50);
    a.send("park", { id: "abc123", spec: { type: "sedan", paint: "#ff0000", variant: "normal", hp: 500 }, x: 12, halfLen: 2.2, from: { x: 1, y: 2, z: 3 } });
    await sleep(100);
    assert.strictEqual(seenByB.length, 1);
    assert.strictEqual(seenByB[0].id, "abc123");
    assert.strictEqual(seenByB[0].by, a.sessionId);
    assert.ok(seenByA.some((m) => m.id === "abc123"), "the sender gets the echo too");
    assert.strictEqual(room.rounds.main.vehicles.size, 1);
  });

  it("refuses a bad throw to the sender only", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const refused: any[] = [];
    a.onMessage("railRefuse", (m) => refused.push(m));
    a.send("park", { id: "bad", spec: { type: "sedan", hp: -5 }, x: 1, halfLen: 2 });
    await sleep(80);
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(room.rounds.main.vehicles.size, 0);
  });
});
