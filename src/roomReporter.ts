import { matchMaker } from "@colyseus/core";

// Feeds Bloxity's "Open Rooms" list and cross-pod room directory: every ROOM_REPORT_MS this pod
// POSTs its live rooms to <MATCHMAKER_REPORT_URL>/<BLOXITY_GAME_ID>/rooms. A no-op unless all three
// of MATCHMAKER_REPORT_URL, BLOXITY_REPORT_TOKEN and BLOXITY_GAME_ID are set (Legion hosting only).
const ROOM_REPORT_MS = 2000;
const ROOM_REPORT_TIMEOUT_MS = 4000;

export function installRoomReporter(): void {
  const base = process.env.MATCHMAKER_REPORT_URL;
  const token = process.env.BLOXITY_REPORT_TOKEN;
  const gameId = process.env.BLOXITY_GAME_ID;
  if (!base || !token || !gameId) return;

  const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(gameId)}/rooms`;
  const podName = process.env.POD_NAME || process.env.HOSTNAME || "pod";

  const tick = async () => {
    try {
      const listed = await matchMaker.query({});
      const rooms = listed.map((r) => ({
        colyseusRoomId: r.roomId,
        name: r.name || undefined,
        clients: r.clients ?? 0,
        maxClients: r.maxClients ?? 0,
        locked: !!r.locked,
        private: !!r.private,
        started: !!(r.metadata as Record<string, unknown> | undefined)?.started,
        metadata: r.metadata || undefined,
      }));
      const players = rooms.reduce((n, r) => n + r.clients, 0);
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ podName, players, rooms }),
        signal: AbortSignal.timeout(ROOM_REPORT_TIMEOUT_MS),
      });
    } catch {
      // The directory tolerates gaps; the next tick retries.
    }
  };

  setInterval(() => void tick(), ROOM_REPORT_MS).unref();
  void tick();
}
