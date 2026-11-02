import { reportLeaderboard, type ScoreRow } from "./bloxity.js";
import { LEADERBOARD_STATS, LEGION_PREFIX, REPORT_BATCH_MAX, type LeaderboardStat } from "./constants.js";

// Batches server-owned (saved) scores for Bloxity's hosted leaderboards. One process-wide pending
// map; rooms queue after each accepted save and flush on a timer and on dispose.

const pending = new Map<string, ScoreRow>(); // `${userId}|${board}` -> latest score

// `legion_<id>#m...` -> `legion_<id>`; anything else (dev / guest ids) is not reported.
export function reportableId(accountId: string): string | null {
  if (typeof accountId !== "string") return null;
  const id = accountId.split("#")[0];
  return id.startsWith(LEGION_PREFIX) && id.length > LEGION_PREFIX.length ? id : null;
}

// Marks the stats present in an accepted save as dirty.
export function queueScores(accountId: string, patch: Partial<Record<LeaderboardStat, unknown>>): void {
  const userId = reportableId(accountId);
  if (!userId) return;
  for (const stat of LEADERBOARD_STATS) {
    const v = patch[stat];
    if (typeof v === "number" && Number.isFinite(v)) pending.set(`${userId}|${stat}`, { board: stat, userId, score: v });
  }
}

let flushing: Promise<void> = Promise.resolve();

// Sends everything pending, at most REPORT_BATCH_MAX scores per call. Failed batches are requeued
// (unless a newer score arrived). Calls are serialised; never throws.
export function flushReports(): Promise<void> {
  flushing = flushing.then(doFlush, doFlush);
  return flushing;
}

async function doFlush(): Promise<void> {
  try {
    const rows = [...pending.values()];
    pending.clear();
    for (let i = 0; i < rows.length; i += REPORT_BATCH_MAX) {
      const batch = rows.slice(i, i + REPORT_BATCH_MAX);
      const res = await reportLeaderboard(batch);
      if (res.skipped) continue;
      console.log(`[reporter] ${batch.length} scores: ${res.summary}`);
      if (!res.ok) for (const r of batch) if (!pending.has(`${r.userId}|${r.board}`)) pending.set(`${r.userId}|${r.board}`, r);
    }
  } catch (err) {
    console.warn("[reporter] flush failed", err);
  }
}

export const __pendingForTest = () => pending.size;
export const __clearReportsForTest = () => pending.clear();
