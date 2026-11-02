import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  AD_TOKENS_MAX, GUEST_ID_PREFIX, ID_PATTERN, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, RECONNECT_SECONDS, REPORT_EVERY_MS,
  ROOM_MAX_CLIENTS,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { applyAvatar, applyCarry, applyEmote, applyPose, applyTrain } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { verifyAdReward, verifyToken } from "../bloxity.js";
import { flushReports, queueScores } from "../reporter.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

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

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
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

  // `leaderboard` { boards: { rebirths|breaks|robux: [{ name, value }] }, ranks: { stat: n | null } }.
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
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.identSeq.delete(sessionId);
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
    const now = Date.now();
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
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
