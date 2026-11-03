import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AD_TOKENS_MAX, CHEST, CURRENCY_MAX, DEFAULT_WORLD, GUEST_ID_PREFIX, ID_PATTERN, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS,
  REPORT_EVERY_MS, ROOM_MAX_CLIENTS, ROUND, WORLD_IDS, WORLDS, type WorldId,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { finite, sanitizeProgress } from "../sanitize.js";
import { applyAvatar, applyCarry, applyEmote, applyPose, applyTrain } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { verifyAdReward, verifyToken } from "../bloxity.js";
import { flushReports, queueScores } from "../reporter.js";
import { parkHp } from "../fair.js";
import { Round, type Member } from "../round.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

const isWorld = (v: unknown): v is WorldId => (WORLD_IDS as readonly unknown[]).includes(v);

interface IdentityMsg {
  username?: unknown;
  userId?: unknown;
  pfp?: unknown;
  token?: unknown;
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, pfp, token, avatar, pose })`.
 * Loads and saves each verified player's progress (MongoDB, see db.ts) -- the client keeps no save
 * of its own. Client-authoritative: saves are only bounded (sanitize.ts). Full rooms spill into a
 * fresh one automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> account id (`legion_<id>`, or a `dev-` id outside production). NOT part of
  // WorldState: it only gates this room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write.
  private loaded = new Set<string>();
  // Latest identity request per session, so a slow token verify can't overwrite a newer one.
  private identSeq = new Map<string, number>();
  // Single-use rewarded-ad tokens seen by this room (bounded, oldest dropped first).
  private adTokens = new Set<string>();

  // sessionId -> seconds played toward the free coins chest (0..CHEST.playSeconds). Only sessions whose
  // save has been read are counted. Server-owned: never taken from the client.
  private chestPlay = new Map<string, number>();
  // sessionIds whose tab is hidden: no chest time while away.
  private hidden = new Set<string>();
  // sessionId -> rebirths in this account's save (setWorld's gate). Guests have no entry.
  private rebirths = new Map<string, number>();

  // sessionId -> one load of this player (fair.ts parkHp: best vehicle x Carry), from its `stats`.
  private loads = new Map<string, number>();

  // One shared rail and train per world (round.ts): everyone in a world parks against the same train,
  // sized to the players there with a visible tab.
  rounds = Object.fromEntries(
    WORLD_IDS.map((id) => [
      id,
      new Round((type, payload) => this.sendToWorld(id, type, payload), undefined, undefined, id, () => this.membersOf(id)),
    ]),
  ) as Record<WorldId, Round>;

  private membersOf(world: WorldId): Member[] {
    const out: Member[] = [];
    for (const [sid, load] of this.loads) {
      if (this.state.players.has(sid) && this.worldOf(sid) === world && !this.hidden.has(sid)) out.push({ sid, parkHp: load });
    }
    return out;
  }

  private worldOf(sessionId: string): WorldId {
    const world = this.state.players.get(sessionId)?.world;
    return isWorld(world) ? world : DEFAULT_WORLD;
  }
  private sendToWorld(world: WorldId, type: string, payload: unknown) {
    this.broadcast(type, payload, { except: this.clients.filter((c) => this.worldOf(c.sessionId) !== world) });
  }

  messages = {
    // `park` { id, spec, x, halfLen, from }: a vehicle thrown onto the sender's rail (the echo is `railAdd`).
    park: (client: Client, msg: unknown) => {
      const round = this.rounds[this.worldOf(client.sessionId)];
      if (!round.park(client.sessionId, msg)) client.send("railRefuse", { id: (msg as { id?: unknown })?.id });
    },
    // `seedRail` [{ spec, x, halfLen }]: the first client into a new world stocks its rail once.
    seedRail: (client: Client, msg: unknown) => this.rounds[this.worldOf(client.sessionId)].seed(msg),
    // `setWorld` { world, rebirths }: moves the sender to another world and answers with its `round`, or
    // `worldRefused` { world } when the rebirths fall short. An account is judged by its save; a guest has
    // none, so it states its own count (guests are client-authoritative like everything else they do).
    setWorld: (client: Client, msg: { world?: unknown; rebirths?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      const world = msg?.world;
      if (!p || !isWorld(world)) return;
      const stated = finite(msg.rebirths) ? msg.rebirths : 0;
      const rebirths = this.userIds.has(client.sessionId) ? this.rebirths.get(client.sessionId) ?? 0 : stated;
      if (rebirths < WORLDS[world].rebirths) return client.send("worldRefused", { world });
      p.world = world;
      client.send("round", this.rounds[world].snapshot());
    },
    // `stats` { power, carry }: the sender's Strength and Carry level, which size the trains (fair.ts).
    // Client-authoritative like the rest of the game; only bounded here.
    stats: (client: Client, msg: { power?: unknown; carry?: unknown }) => {
      if (!this.state.players.has(client.sessionId) || !finite(msg?.power) || !finite(msg?.carry)) return;
      this.loads.set(client.sessionId, parkHp(Math.min(CURRENCY_MAX, Math.max(0, msg.power)), msg.carry));
    },
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      if (patch.rebirths !== undefined) this.rebirths.set(client.sessionId, patch.rebirths);
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...patch, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
        queueScores(userId, patch); // saved (server-owned) state only
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // `visible { on }`: the tab was hidden / shown. Hidden time does not count toward the chest.
    visible: (client: Client, msg: { on?: unknown }) => {
      if (msg?.on === false) this.hidden.add(client.sessionId);
      else this.hidden.delete(client.sessionId);
    },
    // Opens the free coins chest once CHEST.playSeconds have been played. The server only attests
    // (`chestResult`); the client adds the coins, as with ads. Checked and reset in one synchronous step,
    // so a double click can't pay twice.
    claimChest: (client: Client) => {
      const play = this.chestPlay.get(client.sessionId);
      if (play === undefined || play < CHEST.playSeconds) {
        return client.send("chestResult", { ok: false, play: play ?? 0 });
      }
      this.chestPlay.set(client.sessionId, 0);
      client.send("chestResult", { ok: true, coins: CHEST.coins, play: 0 });
      void this.persistChest(client.sessionId);
    },
    // Presence: relayed through the roster so everyone draws the sender.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    carry: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyCarry(p, msg);
    },
    train: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyTrain(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    emote: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyEmote(p, msg);
    },
    // Rewarded ad: the server only attests (`adResult`), the client grants the reward.
    adReward: async (client: Client, msg: { token?: unknown; placement?: unknown }) => {
      const placement = typeof msg?.placement === "string" && ID_PATTERN.test(msg.placement) ? msg.placement : "";
      const token = msg?.token;
      if (!placement || typeof token !== "string" || !token) return client.send("adResult", { ok: false, placement, reason: "bad" });
      if (this.adTokens.has(token)) return client.send("adResult", { ok: false, placement, reason: "used" });
      this.adTokens.add(token); // burn first so a concurrent replay is refused
      if (this.adTokens.size > AD_TOKENS_MAX) this.adTokens.delete(this.adTokens.values().next().value as string);
      const valid = await verifyAdReward(token);
      if (!valid) {
        this.adTokens.delete(token); // an unverified token may be retried
        return client.send("adResult", { ok: false, placement, reason: "invalid" });
      }
      client.send("adResult", { ok: true, placement });
      if (placement === CHEST.adPlacement && this.chestPlay.has(client.sessionId)) {
        this.chestPlay.set(client.sessionId, CHEST.playSeconds);
        client.send("chest", { play: CHEST.playSeconds });
        void this.persistChest(client.sessionId);
      }
    },
    // Re-states identity after a login/logout AFTER join. Answers progress/noProgress.
    identify: (client: Client, msg: IdentityMsg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      void this.applyIdentity(client, p, msg ?? {});
    },
  };

  // Leaderboards: everyone gets the top lists + their own ranks every LEADERBOARD_EVERY_MS, and
  // once after their save loads. Scores reach Bloxity every REPORT_EVERY_MS and on dispose.
  onCreate() {
    let last = Date.now();
    this.clock.setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      for (const id of WORLD_IDS) this.rounds[id].tick(dt);
      last = now;
    }, ROUND.tickMs);
    // Chest play time: one second per tick for every loaded, visible player; corrected to the client
    // every syncEverySec and saved every saveEverySec.
    let chestTicks = 0;
    this.clock.setInterval(() => {
      chestTicks += 1;
      for (const c of this.clients) {
        const id = c.sessionId;
        const play = this.chestPlay.get(id);
        if (play === undefined) continue;
        if (!this.hidden.has(id) && play < CHEST.playSeconds) this.chestPlay.set(id, Math.min(CHEST.playSeconds, play + 1));
        if (chestTicks % CHEST.syncEverySec === 0) c.send("chest", { play: this.chestPlay.get(id) });
        if (chestTicks % CHEST.saveEverySec === 0) void this.persistChest(id);
      }
    }, 1000);
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    this.clock.setInterval(() => {
      void flushReports();
    }, REPORT_EVERY_MS);
  }

  async onDispose() {
    await flushReports();
  }

  // `leaderboard` { boards: { rebirths|breaks|strength: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  onJoin(client: Client, options?: IdentityMsg & { pose?: unknown; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    applyPose(p, options?.pose);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    client.send("round", this.rounds[DEFAULT_WORLD].snapshot());
    void this.applyIdentity(client, p, options ?? {});
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    const chestPlay = this.chestPlay.get(sessionId);
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now(), ...(chestPlay === undefined ? {} : { chestPlay: Math.floor(chestPlay) }) } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Writes the chest play time of a signed-in player (guests have none). No upsert: a new account's
  // first saveProgress creates the document.
  private async persistChest(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    const play = this.chestPlay.get(sessionId);
    if (!userId || !players || play === undefined) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { chestPlay: Math.floor(play) } });
    } catch (err) {
      console.warn("[WorldRoom] persistChest failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.identSeq.delete(sessionId);
    this.chestPlay.delete(sessionId);
    this.hidden.delete(sessionId);
    this.rebirths.delete(sessionId);
    this.loads.delete(sessionId);
  }

  // Resolves who this connection is. With a `token`: verified through Bloxity (account id
  // `legion_<user._id>`, name/pfp from the verified user); invalid / unreachable = guest. Without
  // a token a client `userId` is trusted ONLY outside production (dev ids); `guest-` ids never.
  private async applyIdentity(client: Client, p: PlayerState, msg: IdentityMsg) {
    const seq = (this.identSeq.get(client.sessionId) ?? 0) + 1;
    this.identSeq.set(client.sessionId, seq);

    if (typeof msg.username === "string") p.username = sanitizeName(msg.username);
    if (typeof msg.pfp === "string") p.pfp = sanitizePfp(msg.pfp);

    let accountId = "";
    let carriedFrom: string[] = [];
    const token = typeof msg.token === "string" ? msg.token : "";
    if (token) {
      const user = await verifyToken(token);
      // Left, or asked again, while the verify was in flight.
      if (this.state.players.get(client.sessionId) !== p || this.identSeq.get(client.sessionId) !== seq) return;
      if (user) {
        accountId = `legion_${user.id}`;
        carriedFrom = user.carriedFrom;
        if (user.username) p.username = sanitizeName(user.username);
        p.pfp = sanitizePfp(user.pfp);
      }
    } else if (process.env.NODE_ENV !== "production" && typeof msg.userId === "string") {
      const id = msg.userId.slice(0, 128);
      if (id && !id.startsWith(GUEST_ID_PREFIX)) accountId = id;
    }
    this.setAccount(client, p, accountId, carriedFrom);
  }

  // Switches this session to `userId` ("" = guest) and answers with progress / noProgress / serverError.
  private setAccount(client: Client, p: PlayerState, userId: string, carriedFrom: string[]) {
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.rebirths.delete(client.sessionId);
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session on this account, so one account never has two Mongo writers
      // (a crashed tab lingers up to RECONNECT_SECONDS via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p, carriedFrom);
  }

  // Sends the saved doc ("progress"), or "noProgress" (new account, guest, no Mongo). A failed
  // read sends "serverError" and keeps saving off. A verified account without a doc inherits the
  // first available doc of `carriedFrom` (carry-over), which is then marked `carriedTo`.
  private async loadProgress(client: Client, userId: string, p: PlayerState, carriedFrom: string[]) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
        if (!doc) doc = await this.carryOver(userId, carriedFrom);
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    if (userId) this.rebirths.set(client.sessionId, doc?.rebirths ?? 0);
    const play = Math.min(CHEST.playSeconds, Math.max(0, doc?.chestPlay ?? 0));
    this.chestPlay.set(client.sessionId, play);
    const now = Date.now();
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
    client.send("chest", { play }); // after progress: hydrating the save resets the client's count
    void this.sendLeaderboard(client);
  }

  // Copies the first usable carriedFrom doc into `userId`'s doc and marks the source carriedTo.
  private async carryOver(userId: string, carriedFrom: string[]): Promise<PlayerDoc | null> {
    const players = getPlayers();
    if (!players) return null;
    for (const srcId of carriedFrom) {
      if (!srcId || srcId === userId) continue;
      const src = await players.findOne({ _id: srcId });
      if (!src || src.carriedTo) continue;
      const { _id, carriedTo, ...rest } = src;
      const copy: Partial<PlayerDoc> = { ...rest, carriedFrom: srcId, updatedAt: new Date() };
      await players.updateOne({ _id: userId }, { $set: copy, $setOnInsert: { version: 1 } }, { upsert: true });
      await players.updateOne({ _id: srcId }, { $set: { carriedTo: userId } });
      return { _id: userId, version: 1, ...copy } as PlayerDoc;
    }
    return null;
  }
}
