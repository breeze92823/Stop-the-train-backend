// Players per room. The deploy workflow greps this number (keep it 2-100, no seatCap).
export const ROOM_MAX_CLIENTS = 50;

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
export const LEADERBOARD_STATS = ["rebirths", "breaks", "robux"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Bloxity hosted leaderboards: the three boards, declared ONCE. The frontend declares the same
// ones via Legion.SDK.leaderboard.define. `id` = the stat name above.
export const BLOXITY_BOARDS = [
  { id: "rebirths", label: "Rebirths", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "breaks", label: "Trains Derailed", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "robux", label: "Robux Spent", order: "desc", mode: "best", format: "compact", reset: "none" },
] as const;
export const REPORT_EVERY_MS = 15 * 1000;
export const REPORT_BATCH_MAX = 200;
// Account ids reported to Bloxity: `legion_<_id>` (any `#m...` suffix is stripped).
export const LEGION_PREFIX = "legion_";

// Bloxity game slug used in verify calls; the env BLOXITY_GAME_ID wins. PLACEHOLDER until the
// real game is created on the dashboard.
export const GAME_SLUG_DEFAULT = "climb-and-slide-for-eggs";
export const BLOXITY_API_DEFAULT = "https://api.bloxity.io";
export const BLOXITY_TIMEOUT_MS = 5000;

// Rewarded ads: tokens remembered (single use) per room, and the longest accepted token.
export const AD_TOKENS_MAX = 5000;
export const AD_TOKEN_MAX_LEN = 2048;

// Ids from the client's catalogs (vehicle models, upgrades): slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
