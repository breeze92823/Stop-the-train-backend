// Players per room. The deploy workflow greps this number (keep it 2-100, no seatCap).
export const ROOM_MAX_CLIENTS = 10;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw (never parsed),
// and the pose bounds: the world lies within +-`pos` m on every axis; speed in m/s.
export const AVATAR_MAX_LEN = 3000;
export const POSE_BOUNDS = { pos: 2000, speed: 500 };
// Emote ids ("wave", "12"): digits / slugs up to 64 chars. "" stops the emote.
export const EMOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules.
export const CURRENCY_MAX = 1e18; // coins, power, luck, multiplier, powerMult, breaks, robux
export const REBIRTHS_MAX = 1e9;
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year
// Upgrade levels { upgradeId: int } (magnet, carry, cooldown, fuse, walkspeed ...).
export const LEVEL_KINDS_MAX = 64;
export const LEVEL_MAX = 1e6;
// Unix-second timestamps (dailyAt, chestAt, updateEnds) and the daily streak counter.
export const UNIX_S_MAX = 4_102_444_800; // year 2100
export const DAILY_DAY_MAX = 10_000;

// Leaderboards (leaderboard.ts): the saved doc fields ranked, rows per board and how often the
// lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["rebirths", "breaks", "strength"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Bloxity hosted leaderboards: the three boards, declared ONCE. The frontend declares the same
// ones via Legion.SDK.leaderboard.define. `id` = the stat name above.
export const BLOXITY_BOARDS = [
  { id: "rebirths", label: "Rebirths", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "breaks", label: "Trains Derailed", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "strength", label: "Strength", order: "desc", mode: "best", format: "compact", reset: "none" },
] as const;
export const REPORT_EVERY_MS = 15 * 1000;
export const REPORT_BATCH_MAX = 200;
// Account ids reported to Bloxity: `legion_<_id>` (any `#m...` suffix is stripped).
export const LEGION_PREFIX = "legion_";

// Bloxity game slug used in verify calls; the env BLOXITY_GAME_ID wins. PLACEHOLDER until the
// real game is created on the dashboard.
export const GAME_SLUG_DEFAULT = "stop-the-train";
export const BLOXITY_API_DEFAULT = "https://api.bloxity.io";
export const BLOXITY_TIMEOUT_MS = 5000;

// Rewarded ads: tokens remembered (single use) per room, and the longest accepted token.
export const AD_TOKENS_MAX = 5000;
export const AD_TOKEN_MAX_LEN = 2048;

// The FREE COINS chest: the server counts a player's play time (connected, tab visible) and opens the
// chest after `playSeconds`. Mirrors the frontend FREE_COINS. `adPlacement` is the rewarded ad that fills it.
export const CHEST = {
  playSeconds: 30 * 60,
  coins: 10_000,
  adPlacement: "chest-refill",
  syncEverySec: 10, // `chest` message to each client, to correct its local countdown
  saveEverySec: 30, // signed-in players' count is written to Mongo
} as const;

// Ids from the client's catalogs (vehicle models, upgrades): slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The worlds of a room: the same game, each with its own rail, train and players. `rebirths` is what
// entering takes. Mirrors the frontend's WORLDS in config.js.
export const WORLDS = {
  main: { rebirths: 0 },
  galaxy: { rebirths: 36 },
} as const;
export type WorldId = keyof typeof WORLDS;
export const WORLD_IDS = Object.keys(WORLDS) as WorldId[];
export const DEFAULT_WORLD: WorldId = "main";

// The shared round (round.ts): ONE rail and ONE train per world of a room, so everyone's vehicles
// stack up against the same train. Mirrors the frontend's ROUND / TRAINS / TRACK in config.js.
export const ROUND = {
  countdown: 90, // s between trains
  firstCountdown: 79,
  approachSeconds: 2.6,
  wreckSeconds: 11,
  tickMs: 50,
  syncEveryMs: 100, // train position broadcast while it runs
  doubleChance: 0.3,
  brake: 7, // m/s^2 the train speed eases toward its target
  mouth: 92, // TRACK.mouth
  placeHalf: 74, // TRACK.placeHalf
  locoLength: 19,
  wagonLength: 14,
  gap: 1.1,
  railCap: 80, // vehicles on the rail at once
  perPlayerCap: 12, // of them one player may own
  hpMax: 1e14,
} as const;
// Weakest first. hp / speed / weight / wagons mirror the frontend TRAINS.
export const TRAIN_TABLE = [
  { hp: 12e3, speed: 25, weight: 44, wagons: 2 },
  { hp: 60e3, speed: 27, weight: 28, wagons: 3 },
  { hp: 300e3, speed: 29, weight: 16, wagons: 3 },
  { hp: 3e6, speed: 31, weight: 8, wagons: 4 },
  { hp: 57e6, speed: 33, weight: 4, wagons: 4 },
  { hp: 500e6, speed: 35, weight: 2, wagons: 5 },
  { hp: 4e9, speed: 36, weight: 1, wagons: 5 },
  { hp: 35e9, speed: 37, weight: 0.5, wagons: 6 },
  { hp: 300e9, speed: 38, weight: 0.25, wagons: 6 },
  { hp: 2.5e12, speed: 40, weight: 0.1, wagons: 6 },
] as const;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
