import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // verified Bloxity name when signed in, else the client's
    signedIn: t.boolean().default(false), // has a verified account: only these are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // Presence (presence.ts): what the others draw in the world.
    x: t.float64().default(0),
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad
    speed: t.float32().default(0), // m/s
    grounded: t.boolean().default(true),
    vy: t.float32().default(0), // vertical velocity m/s
    carry: t.string().default(""), // vehicle held overhead: JSON {"type","paint","variant"}, "" = none
    bench: t.int8().default(-1), // gym bench being used, -1 = not training
    benchRep: t.float32().default(0), // 0..1 bar phase while training
    avatar: t.string().default(""), // Bloxity look JSON, "" = default (never parsed)
    emote: t.string().default(""), // current emote id, "" = none
    emoteSeq: t.uint32().default(0), // incremented per emote message so repeats replay
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
