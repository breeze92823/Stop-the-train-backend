import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([{ _id: "dev-u1", coins: 5000, levels: { magnet: 3 }, rebirths: 2, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "dev-u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.coins, 5000);
    assert.deepStrictEqual(got?.levels, { magnet: 3 });
    assert.ok(got?.serverTime > 0);

    c.send("saveProgress", { coins: 7000, breaks: 4, levels: { carry: 2 }, seeded: true, hack: 1 });
    await sleep(150);
    const doc = fake.docs.get("dev-u1")! as any;
    assert.strictEqual(doc.coins, 7000);
    assert.strictEqual(doc.breaks, 4);
    assert.deepStrictEqual(doc.levels, { carry: 2 });
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("creates a new account save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "dev-new1" });
    let none = false;
    c.onMessage("noProgress", () => (none = true));
    fake.release();
    await sleep(150);
    assert.ok(none);
    c.send("saveProgress", { coins: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-new1")?.coins, 10);

    const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
    guest.onMessage("noProgress", () => {});
    await sleep(150);
    guest.send("saveProgress", { coins: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "dev-u2", coins: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-x" });
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    c.send("identify", { userId: "dev-u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.coins, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "dev-u3", coins: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "dev-u3" });
    let failed = false;
    c.onMessage("serverError", () => (failed = true));
    fake.release();
    await sleep(150);
    assert.ok(failed);
    c.send("saveProgress", { coins: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("dev-u3")!.coins, 1e9, "the unread save is never overwritten");
  });

  it("evicts a second live session on the same account", async () => {
    const fake = fakePlayers();
    fake.release();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "dev-dup" });
    await sleep(100);
    const b = await colyseus.connectTo(room, { userId: "dev-dup" });
    await sleep(150);
    assert.ok(!room.state.players.has(a.sessionId), "the older session is gone");
    assert.ok(room.state.players.has(b.sessionId));
  });
});
