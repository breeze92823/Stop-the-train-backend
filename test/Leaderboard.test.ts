import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { LEADERBOARD_SIZE } from "../src/constants.js";
import { __resetLeaderboardForTest } from "../src/leaderboard.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const doc = (id: string, f: Partial<PlayerDoc>): PlayerDoc => ({ _id: id, version: 1, updatedAt: new Date(), ...f });

describe("leaderboard", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetLeaderboardForTest();
  });
  afterEach(() => __setPlayersForTest(null));

  it("sends the top saved players per stat and the own ranks after the load", async () => {
    const seed = [
      doc("dev-u1", { username: "Ann", rebirths: 3, breaks: 500, robux: 10 }),
      doc("dev-u2", { username: "Bo", rebirths: 9, breaks: 100 }),
      ...Array.from({ length: 15 }, (_, i) => doc(`x${i}`, { username: `P${i}`, breaks: 1000 + i })),
    ];
    const fake = fakePlayers(seed);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "dev-u1", username: "Ann" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("progress", () => {});
    fake.release();
    await sleep(200);
    assert.ok(got, "leaderboard sent after the load");
    assert.deepStrictEqual(got.boards.rebirths, [{ name: "Bo", value: 9 }, { name: "Ann", value: 3 }]);
    assert.strictEqual(got.boards.breaks.length, LEADERBOARD_SIZE);
    assert.deepStrictEqual(got.boards.breaks[0], { name: "P14", value: 1014 });
    assert.deepStrictEqual(got.boards.robux, [{ name: "Ann", value: 10 }], "players without a score are left out");
    assert.deepStrictEqual(got.ranks, { rebirths: 2, breaks: 16, robux: 1 });
  });

  it("gives a player with no save the lists and no ranks", async () => {
    const fake = fakePlayers([doc("dev-u1", { username: "Ann", rebirths: 3 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "dev-u9", username: "New" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("noProgress", () => {});
    fake.release();
    await sleep(200);
    assert.deepStrictEqual(got?.boards.rebirths, [{ name: "Ann", value: 3 }]);
    assert.deepStrictEqual(got?.ranks, { rebirths: null, breaks: null, robux: null });
  });
});
