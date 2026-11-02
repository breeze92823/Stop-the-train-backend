import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { closeDb, connectDb } from "./db.js";
import { flushReports } from "./reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// SIGTERM drain: Colyseus (gracefullyShutdown, on by default) stops accepting joins and disposes
// the rooms (each flushes its scores); then this runs: a last score flush and the Mongo close.
app.onShutdown(async () => {
  await flushReports();
  await closeDb();
});

console.log(`[server] pod=${process.env.POD_NAME || "local"} channel=${process.env.BLOXITY_CHANNEL || "-"}`);

// Listens on PORT (or 2567).
listen(app);
