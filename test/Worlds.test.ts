import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WORLDS } from "../src/constants.js";
import { __setPlayersForTest } from "../src/db.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const NEED = WORLDS.galaxy.rebirths;
const vehicle = (id: string) => ({ id, spec: { type: "sedan", paint: "#ff0000", variant: "normal", hp: 500 }, x: 12, halfLen: 2.2, from: null });

describe("worlds", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("starts everyone in the main world", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(30);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "main");
  });

  it("moves a guest with the rebirths and answers with that world's round", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const rounds: any[] = [];
    a.onMessage("round", (m) => rounds.push(m));
    a.send("setWorld", { world: "galaxy", rebirths: NEED });
    await sleep(80);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "galaxy");
    assert.strictEqual(rounds.at(-1)?.world, "galaxy");
  });

  it("refuses too few rebirths and an unknown world", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const refused: any[] = [];
    a.onMessage("worldRefused", (m) => refused.push(m));
    a.send("setWorld", { world: "galaxy", rebirths: NEED - 1 });
    a.send("setWorld", { world: "moon", rebirths: 1e9 });
    await sleep(80);
    assert.deepStrictEqual(refused, [{ world: "galaxy" }]);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "main");
  });

  it("judges an account by its save, not by what it states", async () => {
    const fake = fakePlayers([{ _id: "dev-w1", rebirths: 3, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "dev-w1" });
    const refused: any[] = [];
    a.onMessage("progress", () => {});
    a.onMessage("worldRefused", (m) => refused.push(m));
    fake.release();
    await sleep(120);
    a.send("setWorld", { world: "galaxy", rebirths: 1e9 });
    await sleep(80);
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "main");

    // The save that reaches the rebirths opens it at once, even with the write still in flight.
    a.send("saveProgress", { rebirths: NEED });
    a.send("setWorld", { world: "galaxy" });
    await sleep(80);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "galaxy");
  });

  it("keeps a separate rail per world and only tells the players in it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const earth = await colyseus.connectTo(room, { userId: "guest-e" });
    const space = await colyseus.connectTo(room, { userId: "guest-s" });
    const seenOnEarth: any[] = [];
    const seenInSpace: any[] = [];
    earth.onMessage("railAdd", (m) => seenOnEarth.push(m));
    space.onMessage("railAdd", (m) => seenInSpace.push(m));
    space.send("setWorld", { world: "galaxy", rebirths: NEED });
    await sleep(60);

    space.send("park", vehicle("up1"));
    earth.send("park", vehicle("down1"));
    await sleep(100);
    assert.deepStrictEqual(seenOnEarth.map((m) => m.id), ["down1"]);
    assert.deepStrictEqual(seenInSpace.map((m) => m.id), ["up1"]);
    assert.deepStrictEqual([...room.rounds.main.vehicles.keys()], ["down1"]);
    assert.deepStrictEqual([...room.rounds.galaxy.vehicles.keys()], ["up1"]);
  });

  it("seeds each world's rail once, and shows what is on it to a player arriving", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    a.send("seedRail", [{ spec: vehicle("x").spec, x: 1, halfLen: 2 }]);
    a.send("setWorld", { world: "galaxy", rebirths: NEED });
    a.send("seedRail", [{ spec: vehicle("x").spec, x: 2, halfLen: 2 }]);
    await sleep(80);
    assert.strictEqual(room.rounds.main.vehicles.size, 1);
    assert.strictEqual(room.rounds.galaxy.vehicles.size, 1);

    let arrived: any = null;
    b.onMessage("round", (m) => (arrived = m));
    b.send("setWorld", { world: "galaxy", rebirths: NEED });
    await sleep(80);
    assert.strictEqual(arrived?.world, "galaxy");
    assert.strictEqual(arrived?.seeded, true);
    assert.strictEqual(arrived?.rail.length, 1);
  });

  it("lets a player go back to the main world whatever the rebirths", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    a.send("setWorld", { world: "galaxy", rebirths: NEED });
    a.send("setWorld", { world: "main" });
    await sleep(80);
    assert.strictEqual(room.state.players.get(a.sessionId)?.world, "main");
  });
});
