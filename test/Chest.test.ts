import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { CHEST } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("free coins chest", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("refuses a claim before the play time, then pays once after it", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const results: any[] = [];
    a.onMessage("chestResult", (m) => results.push(m));
    await sleep(80);

    a.send("claimChest");
    await sleep(60);
    assert.strictEqual(results[0].ok, false);

    (room as any).chestPlay.set(a.sessionId, CHEST.playSeconds);
    a.send("claimChest");
    a.send("claimChest");
    await sleep(80);
    assert.deepStrictEqual(results.slice(1).map((r) => r.ok), [true, false]);
    assert.strictEqual(results[1].coins, 10_000);
    assert.strictEqual((room as any).chestPlay.get(a.sessionId), 0);
  });

  it("does not count time while the tab is hidden", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    await sleep(80);
    a.send("visible", { on: false });
    await sleep(1300);
    assert.strictEqual((room as any).chestPlay.get(a.sessionId), 0);
    a.send("visible", { on: true });
    await sleep(1300);
    assert.ok((room as any).chestPlay.get(a.sessionId) >= 1);
  });
});
