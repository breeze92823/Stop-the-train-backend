import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setFetchForTest, type FetchLike } from "../src/bloxity.js";
import { BLOXITY_BOARDS, REPORT_BATCH_MAX } from "../src/constants.js";
import { __clearReportsForTest, __pendingForTest, flushReports, queueScores, reportableId } from "../src/reporter.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

// A fetch fake: records calls, answers via `reply(url, body)`.
function fakeFetch(reply: (url: string, body: any, headers: Record<string, string>) => { status?: number; data: unknown } | Error) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = reply(url, body, init.headers);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 300, status, json: async () => r.data };
  };
  return { calls, f };
}

const ENV_KEYS = ["BLOXITY_API_URL", "BLOXITY_GAME_ID", "BLOXITY_REPORT_TOKEN"] as const;

describe("bloxity", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const saved: Record<string, string | undefined> = {};
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.BLOXITY_API_URL = "https://api.test";
    delete process.env.BLOXITY_GAME_ID;
    delete process.env.BLOXITY_REPORT_TOKEN;
    __clearReportsForTest();
  });
  afterEach(() => {
    __setFetchForTest(null);
    __setPlayersForTest(null);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("token verify", () => {
    it("uses the verified account id, name and pfp, and saves under it", async () => {
      const { calls, f } = fakeFetch(() => ({ data: { valid: true, user: { _id: "abc123", username: "ann", displayName: "Ann D", pfp: "https://static.bloxity.io/p.png" } } }));
      __setFetchForTest(f);
      const fake = fakePlayers();
      fake.release();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { token: "tok-1", userId: "dev-forged", username: "Forged" });
      c.onMessage("noProgress", () => {});
      await sleep(150);
      const p = room.state.players.get(c.sessionId)!;
      assert.strictEqual(p.signedIn, true);
      assert.strictEqual(p.username, "Ann D");
      assert.strictEqual(p.pfp, "https://static.bloxity.io/p.png");
      assert.strictEqual(calls[0].url, "https://api.test/v1/auth/game-token/verify");
      assert.strictEqual(calls[0].headers.Authorization, "Bearer tok-1");
      assert.strictEqual(typeof calls[0].body.gameSlug, "string");
      c.send("saveProgress", { coins: 5 });
      await sleep(100);
      assert.strictEqual(fake.docs.get("legion_abc123")?.coins, 5);
      assert.ok(!fake.docs.has("dev-forged"));
    });

    it("treats an invalid token, a failed call and a missing user as a guest", async () => {
      const room = await colyseus.createRoom<WorldState>("world", {});
      for (const reply of [
        () => ({ data: { valid: false } }),
        () => new Error("network down"),
        () => ({ data: { valid: true } }),
        () => ({ status: 500, data: null }),
      ]) {
        __setFetchForTest(fakeFetch(reply as any).f);
        const c = await colyseus.connectTo(room, { token: "bad", userId: "dev-forged" });
        await sleep(100);
        assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, false);
      }
    });

    it("verifies a token sent with identify", async () => {
      __setFetchForTest(fakeFetch(() => ({ data: { valid: true, user: { _id: "u9", username: "Zed" } } })).f);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, {});
      await sleep(50);
      c.send("identify", { token: "t", username: "x", pfp: "" });
      await sleep(120);
      const p = room.state.players.get(c.sessionId)!;
      assert.strictEqual(p.signedIn, true);
      assert.strictEqual(p.username, "Zed");
    });
  });

  describe("carry-over", () => {
    it("copies the first available carriedFrom doc and marks it carriedTo", async () => {
      __setFetchForTest(fakeFetch(() => ({ data: { valid: true, user: { _id: "n1", username: "N" }, carriedFrom: ["missing", "old1", "old2"] } })).f);
      const fake = fakePlayers([
        { _id: "old1", coins: 777, levels: { magnet: 2 }, version: 1, updatedAt: new Date() },
        { _id: "old2", coins: 1, version: 1, updatedAt: new Date() },
      ]);
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { token: "t" });
      let got: any = null;
      c.onMessage("progress", (m: any) => (got = m));
      fake.release();
      await sleep(200);
      assert.strictEqual(got?.coins, 777);
      assert.strictEqual((fake.docs.get("legion_n1") as any).coins, 777);
      assert.strictEqual((fake.docs.get("old1") as any).carriedTo, "legion_n1");
      assert.strictEqual((fake.docs.get("old2") as any).carriedTo, undefined);

      // A second new account cannot reuse the already carried doc.
      __setFetchForTest(fakeFetch(() => ({ data: { valid: true, user: { _id: "n2", username: "M" }, carriedFrom: ["old1"] } })).f);
      const d = await colyseus.connectTo(room, { token: "t2" });
      d.onMessage("noProgress", () => {});
      await sleep(200);
      assert.strictEqual(room.state.players.get(d.sessionId)?.signedIn, true);
      assert.ok(!fake.docs.has("legion_n2"));
    });

    it("does not overwrite an account that already has a doc", async () => {
      __setFetchForTest(fakeFetch(() => ({ data: { valid: true, user: { _id: "n3" }, carriedFrom: ["old1"] } })).f);
      const fake = fakePlayers([
        { _id: "legion_n3", coins: 5, version: 1, updatedAt: new Date() },
        { _id: "old1", coins: 777, version: 1, updatedAt: new Date() },
      ]);
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { token: "t" });
      let got: any = null;
      c.onMessage("progress", (m: any) => (got = m));
      fake.release();
      await sleep(150);
      assert.strictEqual(got?.coins, 5);
      assert.strictEqual((fake.docs.get("old1") as any).carriedTo, undefined);
    });
  });

  describe("leaderboard report", () => {
    it("filters to legion ids, strips #m suffixes and batches at 200 scores", async () => {
      process.env.BLOXITY_GAME_ID = "stop-the-train";
      process.env.BLOXITY_REPORT_TOKEN = "rep-tok";
      const { calls, f } = fakeFetch(() => ({ data: { accepted: 1 } }));
      __setFetchForTest(f);
      assert.strictEqual(reportableId("legion_ab#m5"), "legion_ab");
      assert.strictEqual(reportableId("dev-x"), null);
      queueScores("dev-x", { rebirths: 1 });
      queueScores("guest-1", { rebirths: 1 });
      queueScores("legion_one#mfoo", { rebirths: 3, breaks: 9, robux: 2 });
      queueScores("legion_one", { rebirths: 4 }); // later score replaces the earlier one
      for (let i = 0; i < 120; i++) queueScores(`legion_bulk${i}`, { rebirths: i, breaks: i });
      await flushReports();
      assert.strictEqual(calls.length, 2, "123 users x scores split in batches of 200");
      const all = calls.flatMap((c) => c.body.scores);
      assert.ok(calls.every((c) => c.body.scores.length <= REPORT_BATCH_MAX));
      assert.ok(all.every((s: any) => s.userId.startsWith("legion_") && !s.userId.includes("#")));
      assert.deepStrictEqual(all.filter((s: any) => s.userId === "legion_one").map((s: any) => [s.board, s.score]).sort(), [["breaks", 9], ["rebirths", 4], ["robux", 2]]);
      assert.strictEqual(calls[0].url, "https://api.test/v1/leaderboards/hosted/stop-the-train/report");
      assert.strictEqual(calls[0].headers.Authorization, "Bearer rep-tok");
      assert.deepStrictEqual(calls[0].body.boards, JSON.parse(JSON.stringify(BLOXITY_BOARDS)));
      assert.strictEqual(__pendingForTest(), 0);
    });

    it("is a no-op while unconfigured and requeues after a failure", async () => {
      const { calls, f } = fakeFetch(() => ({ status: 500, data: {} }));
      __setFetchForTest(f);
      queueScores("legion_a", { rebirths: 1 });
      await flushReports();
      assert.strictEqual(calls.length, 0, "no token / game id: nothing is sent");
      process.env.BLOXITY_GAME_ID = "g";
      process.env.BLOXITY_REPORT_TOKEN = "t";
      queueScores("legion_a", { rebirths: 2 });
      await flushReports();
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(__pendingForTest(), 1, "a failed batch is kept for the next flush");
    });

    it("queues scores from an accepted save only", async () => {
      process.env.BLOXITY_GAME_ID = "g";
      process.env.BLOXITY_REPORT_TOKEN = "t";
      const { calls, f } = fakeFetch((url) => (url.includes("verify") ? { data: { valid: true, user: { _id: "r1" } } } : { data: {} }));
      __setFetchForTest(f);
      const fake = fakePlayers();
      fake.release();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { token: "t" });
      c.onMessage("noProgress", () => {});
      await sleep(150);
      c.send("saveProgress", { rebirths: 2, breaks: 7, coins: 1 });
      await sleep(100);
      await flushReports();
      const report = calls.find((x) => x.url.includes("/report"))!;
      assert.deepStrictEqual(report.body.scores.map((s: any) => [s.board, s.userId, s.score]).sort(), [["breaks", "legion_r1", 7], ["rebirths", "legion_r1", 2]]);
    });
  });

  describe("rewarded ads", () => {
    it("attests a valid single-use token and refuses a replay or invalid token", async () => {
      const { calls, f } = fakeFetch((_u, body) => ({ data: { valid: body.rewardToken !== "bad" } }));
      __setFetchForTest(f);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "guest-a" });
      const results: any[] = [];
      c.onMessage("adResult", (m: any) => results.push(m));
      c.send("adReward", { token: "good", placement: "coins2x" });
      await sleep(100);
      c.send("adReward", { token: "good", placement: "coins2x" });
      c.send("adReward", { token: "bad", placement: "coins2x" });
      c.send("adReward", { token: "x", placement: "bad placement!" });
      await sleep(150);
      assert.deepStrictEqual(results[0], { ok: true, placement: "coins2x" });
      const byReason = results.slice(1).map((r) => r.reason).sort();
      assert.deepStrictEqual(byReason, ["bad", "invalid", "used"]);
      assert.ok(results.slice(1).every((r) => r.ok === false));
      assert.strictEqual(calls[0].url, "https://api.test/v1/ads/reward/verify");
      assert.strictEqual(calls[0].body.rewardToken, "good");
      assert.strictEqual(typeof calls[0].body.gameSlug, "string");
    });
  });
});
