import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // account id: `legion_<Bloxity user _id>` (guests are never saved)
  username?: string; // display name as of the last save
  coins?: number;
  power?: number; // Strength
  luck?: number;
  multiplier?: number;
  rebirths?: number;
  breaks?: number; // trains derailed
  robux?: number; // Robux spent
  strength?: number; // highest Strength ever reached (power resets on rebirth)
  powerMult?: number; // >= 1
  levels?: Record<string, number>; // upgradeId -> level (magnet, carry, cooldown, fuse, walkspeed)
  dailyAt?: number; // unix s
  dailyDay?: number;
  chestAt?: number; // unix s (legacy: replaced by chestPlay)
  chestPlay?: number; // s played toward the free coins chest; written only by the server, never by saveProgress
  updateEnds?: number; // unix s
  seeded?: boolean;
  muted?: boolean; // sound switched off
  lastSeen?: number; // epoch ms of the last activity
  playtime?: number; // s with the game visible
  carriedFrom?: string; // legacy id this doc was copied from (carry-over)
  carriedTo?: string; // set on a legacy doc once copied: it cannot be reused
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}

// Closes the Mongo connection (SIGTERM drain). Never throws.
export async function closeDb(): Promise<void> {
  const c = client;
  client = null;
  players = null;
  try {
    await c?.close();
  } catch (err) {
    console.warn("[db] close failed", err);
  }
}
