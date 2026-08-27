// Shared Scoring Logic - Extracted for direct use without HTTP calls
//
// Two paths:
//   * LEGACY  (contest_templates.scoring_config IS NULL) — unchanged behavior:
//     reads contest_pool_crews results passed in by the caller, FINISH_POINTS
//     100/75/60/45/30/15/10, predicted-margin tiebreak.
//   * V2      (scoring_config present) — configurable placement scoring, reads
//     contest_races / contest_competitors / contest_race_entries / contest_race_results.
//
// scoring_config presets (frontend sends these in a later phase):
//   classic            = {primitive:'placement', points_table:{"1":100,"2":75,"3":60,"4":45,"5":30,"6":15,"7":10},
//                         direction:'high', dnf_policy:'zero', tiebreak:'margin_error'}
//                        Default for every sport — same game as today's rowing contest.
//                        Margin error is SUMMED over picks (not normalized), exactly like legacy.
//   low_score          = {primitive:'placement', points_table:{}, direction:'low',
//                         dnf_policy:'field_plus_one', tiebreak:'aggregate_time'}
//                        With direction 'low', a missing points_table key means points = place.
//   classic_total_time = classic + tiebreak:'aggregate_time' — admin option for
//                        same-distance slates only (enforced in admin-create-contest).
//   gc_pool            = {primitive:'time_vs_ref', time_ref:'none', dnf_policy:'penalty_pct',
//                         penalty_pct:10, tiebreak:'none'} + roster_mode 'per_competitor'
//                        "lowest combined time across all stages" — every race must share the
//                        same non-empty event_class (enforced in admin-create-contest).
//   team_time_trial    = same config + roster_mode 'per_race' — same event_class rule.
//   deficit            = {primitive:'time_vs_ref', time_ref:'winner', …} + roster_mode 'per_race'
//                        "lowest combined time behind the winners"; mixed distances comparable,
//                        no event_class requirement.
// Fixed-roster rule: direction 'low' OR tiebreak 'aggregate_time' requires min_picks === max_picks.
// Every time_vs_ref config is fixed-roster (min_picks === max_picks).
// time_vs_ref score semantics: total = integer MILLISECONDS, LOWEST wins, no tiebreak.

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

export const FINISH_POINTS: Record<number, number> = {
  1: 100,
  2: 75,
  3: 60,
  4: 45,
  5: 30,
  6: 15,
  7: 10,
};

export function getFinishPoints(position: number): number {
  return FINISH_POINTS[position] ?? 0;
}

/**
 * Parse race time string "MM:SS.ms" or "MM:SS" into total seconds (float)
 */
export function parseRaceTime(timeStr: string): number {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const match = timeStr.match(/^(\d+):(\d+)(?:\.(\d+))?$/);
  if (!match) {
    // Try plain number (seconds only)
    const num = parseFloat(timeStr);
    return isNaN(num) ? 0 : num;
  }
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  const milliseconds = match[3] ? parseInt(match[3].padEnd(2, "0").slice(0, 2), 10) : 0;
  return minutes * 60 + seconds + milliseconds / 100;
}

/**
 * Calculate the margin (in seconds) between 1st and 2nd place in an event.
 * Returns the positive time gap.
 */
export function calculateOfficialMargin(
  crews: Array<{
    crew_id: string;
    manual_finish_order: number | null;
    manual_result_time: string | null;
  }>,
): number {
  const sorted = crews
    .filter((c) => c.manual_finish_order !== null)
    .sort((a, b) => (a.manual_finish_order ?? 999) - (b.manual_finish_order ?? 999));

  if (sorted.length < 2) return 0;

  const t1 = parseRaceTime(sorted[0].manual_result_time || "");
  const t2 = parseRaceTime(sorted[1].manual_result_time || "");
  if (t1 === 0 || t2 === 0) return 0;

  return Math.round(Math.abs(t2 - t1) * 100) / 100;
}

export interface RaceResult {
  crewId: string;
  eventId: string;
  finishOrder: number;
  actualMargin?: number; // time gap to 1st in this event (always positive)
}

interface EntryPick {
  crewId: string;
  event_id?: string;
  predictedMargin: number;
}

interface EntryScore {
  entry_id: string;
  user_id: string;
  total_points: number;
  margin_error: number; // lower = better tiebreaker
  rank?: number;
  payout_cents?: number;
  is_tiebreak_resolved?: boolean;
  is_winner?: boolean;
  is_tie_refund?: boolean;
  crew_scores: CrewScore[];
}

interface CrewScore {
  crew_id: string;
  event_id?: string;
  predicted_margin: number | null;
  actual_margin?: number;
  finish_order: number | null;
  finish_points: number;
  margin_error: number;
  status?: string;
  time_ms?: number | null;
  contribution_ms?: number;
  multiplier?: number;
}

// ---------------------------------------------------------------------------
// V2 (configurable) scoring types
// ---------------------------------------------------------------------------

export const PlacementConfigSchema = z.object({
  primitive: z.literal("placement"),
  points_table: z.record(z.string(), z.number().int().min(0).max(100000)),
  race_multipliers: z.record(z.string(), z.number().int().min(1).max(100)).optional(),
  direction: z.enum(["high", "low"]),
  dnf_policy: z.enum(["zero", "field_plus_one"]),
  tiebreak: z.enum(["margin_error", "aggregate_time", "none"]),
  penalty_pct: z.number().min(0).max(100).optional(),
}).strict();

export const TimeVsRefConfigSchema = z.object({
  primitive: z.literal("time_vs_ref"),
  time_ref: z.enum(["none", "winner"]),
  dnf_policy: z.literal("penalty_pct"),
  penalty_pct: z.number().min(1).max(100).default(10),
  tiebreak: z.literal("none"),
}).strict();

// Survivor is scored round-by-round by score_survivor_round_atomic in Postgres.
// The schema lives here only so create-side validation shares one source of truth;
// scoreConfiguredPool refuses survivor configs outright (see below).
export const SurvivorConfigSchema = z.object({
  primitive: z.literal("survivor"),
  points_table: z.record(z.string(), z.number().int().min(0).max(100000)),
  direction: z.literal("high"),
  dnf_policy: z.literal("zero"),
  tiebreak: z.literal("none"),
}).strict();

// zod 3.22 rejects superRefine'd object schemas as discriminated-union members,
// so the cross-field placement checks live on the union itself.
export const ScoringConfigSchema = z
  .discriminatedUnion("primitive", [PlacementConfigSchema, TimeVsRefConfigSchema, SurvivorConfigSchema])
  .superRefine((c, ctx) => {
    if (c.primitive === "placement") {
      if (c.direction === "high" && c.dnf_policy !== "zero") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "direction high requires dnf_policy zero" });
      }
      if (c.direction === "low" && c.dnf_policy !== "field_plus_one") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "direction low requires dnf_policy field_plus_one" });
      }
      if (c.direction === "low" && c.race_multipliers) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "race_multipliers not allowed with direction low" });
      }
    }
  });

export type PlacementScoringConfig = z.infer<typeof PlacementConfigSchema>;
export type TimeVsRefScoringConfig = z.infer<typeof TimeVsRefConfigSchema>;
export type SurvivorScoringConfig = z.infer<typeof SurvivorConfigSchema>;


export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export type RaceResultV2 = {
  raceKey: string;
  competitorKey: string;
  place: number | null;
  timeMs: number | null;
  status: "OK" | "DNF" | "DNS" | "DSQ" | "PENDING";
  fieldSize: number;
  raceWinnerTimeMs: number | null;
  raceSecondTimeMs: number | null;
  raceSlowestTimeMs: number | null;
};

const DEFAULT_PENALTY_PCT = 10;

/**
 * Score one entry's picks under a placement scoring_config.
 * Throws (message fragment) on an unmatched / unusable pick — caller aggregates
 * and refuses to write anything.
 */
export function reducePlacement(
  picks: EntryPick[],
  resultsByKey: Record<string, RaceResultV2>,
  cfg: PlacementScoringConfig,
): { totalPoints: number; tiebreakValue: number; crewScores: CrewScore[] } {
  let totalPoints = 0;
  let marginErrorSum = 0;
  let aggregateMs = 0;
  const crewScores: CrewScore[] = [];

  for (const pick of picks) {
    const raceKey = pick.event_id ?? "";
    const key = `${raceKey}|${pick.crewId}`;
    const result = resultsByKey[key];

    if (!result) {
      throw new Error(`crew ${pick.crewId} (race ${raceKey}) has no result`);
    }
    if (result.status === "PENDING") {
      throw new Error(`crew ${pick.crewId} (race ${raceKey}) result is PENDING`);
    }
    if (result.status === "OK" && (result.place === null || result.place < 1)) {
      throw new Error(`crew ${pick.crewId} (race ${raceKey}) is OK with no valid place`);
    }

    const multiplier = cfg.race_multipliers?.[raceKey] ?? 1;
    let points = 0;

    if (result.status === "OK") {
      const tablePoints = cfg.points_table[String(result.place)];
      const base = tablePoints ?? (cfg.direction === "low" ? (result.place as number) : 0);
      points = base * multiplier;
    } else {
      // DNF / DNS / DSQ
      if (cfg.dnf_policy === "zero") {
        points = 0;
      } else {
        const fallbackPlace = result.fieldSize + 1;
        points = (cfg.points_table[String(fallbackPlace)] ?? fallbackPlace) * multiplier;
      }
    }

    totalPoints += points;

    let signedMargin = 0;
    let marginError = 0;

    if (cfg.tiebreak === "margin_error") {
      const predicted = pick.predictedMargin;
      if (typeof predicted !== "number" || !Number.isFinite(predicted)) {
        throw new Error(`crew ${pick.crewId} (race ${raceKey}) has no predicted margin`);
      }
      const w = result.raceWinnerTimeMs;
      const s = result.raceSecondTimeMs;
      let gap = 0;
      if (w !== null && s !== null && w !== 0 && s !== 0) {
        // Legacy precision: times truncate to centiseconds before differencing.
        gap = (Math.trunc(s / 10) - Math.trunc(w / 10)) / 100;
        gap = Math.abs(gap);
      }
      signedMargin = result.place === 1 ? gap : -gap;
      marginError = Math.abs(predicted - signedMargin);
      marginErrorSum += marginError;
    } else if (cfg.tiebreak === "aggregate_time") {
      if (result.raceSlowestTimeMs === null) {
        throw new Error(
          `race ${raceKey} has no finisher times (aggregate_time tiebreak requires times)`,
        );
      }
      if (result.status === "OK" && result.timeMs !== null && result.timeMs > 0) {
        aggregateMs += result.timeMs;
      } else {
        const pct = cfg.penalty_pct ?? DEFAULT_PENALTY_PCT;
        aggregateMs += Math.round(result.raceSlowestTimeMs * (1 + pct / 100));
      }
    }

    crewScores.push({
      crew_id: pick.crewId,
      event_id: raceKey,
      predicted_margin: Number.isFinite(pick.predictedMargin) ? pick.predictedMargin : null,
      actual_margin: signedMargin,
      finish_order: result.place,
      finish_points: points,
      margin_error: marginError,
      status: result.status,
      time_ms: result.timeMs,
      multiplier,
    });
  }

  let tiebreakValue = 0;
  if (cfg.tiebreak === "margin_error") {
    tiebreakValue = Math.round(marginErrorSum * 100) / 100;
  } else if (cfg.tiebreak === "aggregate_time") {
    tiebreakValue = aggregateMs; // integer milliseconds
  }

  return { totalPoints, tiebreakValue, crewScores };
}

export type RaceTimeStats = { winner: number | null; slowest: number | null };

/**
 * Score one entry's picks under a time_vs_ref scoring_config.
 * Total is integer milliseconds — LOWEST wins. Throws on any unusable cell so
 * the caller refuses the whole pool (no writes).
 */
export function reduceTimeVsRef(
  picks: EntryPick[],
  resultsByKey: Record<string, RaceResultV2>,
  raceStats: Map<string, RaceTimeStats>,
  cfg: TimeVsRefScoringConfig,
): { totalMs: number; crewScores: CrewScore[] } {
  let totalMs = 0;
  const crewScores: CrewScore[] = [];
  const pct = cfg.penalty_pct ?? DEFAULT_PENALTY_PCT;

  for (const pick of picks) {
    const raceKey = pick.event_id ?? "";
    const result = resultsByKey[`${raceKey}|${pick.crewId}`];

    if (!result) {
      throw new Error(`crew ${pick.crewId} (race ${raceKey}) has no result`);
    }
    if (result.status === "PENDING") {
      throw new Error(`crew ${pick.crewId} (race ${raceKey}) result is PENDING`);
    }

    const stats = raceStats.get(raceKey) ?? { winner: null, slowest: null };
    const winnerMs = stats.winner;
    const slowestMs = stats.slowest;

    if (cfg.time_ref === "winner" && (winnerMs === null || winnerMs <= 0)) {
      throw new Error(`race ${raceKey}: time scoring requires the race winner's time`);
    }

    let contribution: number;

    if (result.status === "OK") {
      const t = result.timeMs;
      if (t === null || t === 0) {
        throw new Error(`crew ${pick.crewId} (race ${raceKey}) is OK with no finish time`);
      }
      contribution = cfg.time_ref === "none" ? t : t - (winnerMs as number);
      if (contribution < 0) {
        throw new Error(
          `race ${raceKey}: ${pick.crewId} time is faster than the recorded race winner — results inconsistent`,
        );
      }
    } else {
      if (slowestMs === null || slowestMs <= 0) {
        throw new Error(`race ${raceKey} has no finisher times (time scoring requires times)`);
      }
      if (cfg.time_ref === "none") {
        contribution = Math.round(slowestMs * (1 + pct / 100));
      } else {
        const spread = slowestMs - (winnerMs as number);
        if (spread < 0) {
          throw new Error(
            `race ${raceKey}: slowest finisher is faster than the recorded race winner — results inconsistent`,
          );
        }
        contribution = Math.max(spread + 1, Math.round(spread * (1 + pct / 100)));
      }
    }

    totalMs += contribution;

    crewScores.push({
      crew_id: pick.crewId,
      event_id: raceKey,
      predicted_margin: null,
      actual_margin: 0,
      finish_order: result.place,
      finish_points: 0,
      margin_error: 0,
      status: result.status,
      time_ms: result.timeMs,
      contribution_ms: contribution,
    });
  }

  return { totalMs, crewScores };
}



function parseEntryPicks(entry: any): EntryPick[] {
  let rawPicks: any[] = [];
  if (Array.isArray(entry.picks)) {
    rawPicks = entry.picks;
  } else if (entry.picks && typeof entry.picks === "object" && Array.isArray((entry.picks as any).crews)) {
    rawPicks = (entry.picks as any).crews;
  }
  return rawPicks.map((p: any) => {
    if (typeof p === "string") return { crewId: p, predictedMargin: NaN } as EntryPick;
    return {
      crewId: String(p.crewId || p.crew_id || p.id || ""),
      event_id: p.event_id,
      predictedMargin: p.predictedMargin ?? p.predicted_margin ?? NaN,
    };
  });
}

/**
 * Score all entries in a contest pool.
 * Writes results to contest_scores (with both pool_id and instance_id)
 * and updates contest_entries status.
 */
export async function scoreContestPool(
  supabase: any,
  contestPoolId: string,
  results: RaceResult[],
): Promise<{ entriesScored: number; winnerId?: string; isTieRefund?: boolean }> {
  console.log("[scoring-logic] Scoring pool:", contestPoolId);

  // Fetch pool + template
  const { data: pool, error: poolError } = await supabase
    .from("contest_pools")
    .select("*, contest_templates(*)")
    .eq("id", contestPoolId)
    .single();

  if (poolError || !pool) {
    throw new Error(`Contest pool not found: ${poolError?.message}`);
  }

  const cfg = pool.contest_templates?.scoring_config ?? null;

  if (cfg === null) {
    return await scoreLegacyPool(supabase, contestPoolId, results, pool);
  }

  return await scoreConfiguredPool(supabase, contestPoolId, pool, cfg);
}

// ---------------------------------------------------------------------------
// LEGACY PATH — unchanged behavior (scoring_config IS NULL)
// ---------------------------------------------------------------------------
async function scoreLegacyPool(
  supabase: any,
  contestPoolId: string,
  results: RaceResult[],
  pool: any,
): Promise<{ entriesScored: number; winnerId?: string; isTieRefund?: boolean }> {
  // Hard guard: refuse to score without race results (prevents zero-scoring locked pools)
  if (!results || results.length === 0) {
    throw new Error(
      `[scoring-logic] Refusing to score pool ${contestPoolId}: empty results array`,
    );
  }

  // Fetch all active entries for this pool
  const { data: entries, error: entriesError } = await supabase
    .from("contest_entries")
    .select("*")
    .eq("pool_id", contestPoolId)
    .in("status", ["active", "scored"]);

  if (entriesError) {
    throw new Error(`Failed to fetch entries: ${entriesError.message}`);
  }

  if (!entries || entries.length === 0) {
    console.log("[scoring-logic] No entries to score for pool:", contestPoolId);
    return { entriesScored: 0 };
  }

  console.log("[scoring-logic] Scoring", entries.length, "entries");

  // Build crew → result lookup with calculated signed margin
  // actualMargin in RaceResult = time gap between 1st and 2nd for the event (always positive)
  // For each crew: 1st place gets +margin, others get -margin
  const resultMap = new Map<string, RaceResult & { calculatedMargin: number }>();
  for (const r of results) {
    const calculatedMargin = r.finishOrder === 1
      ? Math.abs(r.actualMargin || 0)   // 1st place: positive margin (won by X seconds)
      : -(Math.abs(r.actualMargin || 0)); // Others: negative margin (lost by X seconds)
    resultMap.set(String(r.crewId), { ...r, calculatedMargin });
  }

  const scores: EntryScore[] = [];
  // Picks referencing a crew with no race result: hard error, nothing gets written.
  const unmatchedPicks: Array<{ entryId: string; crewId: string; eventId?: string }> = [];

  for (const entry of entries) {
    let picks: EntryPick[] = [];

    try {
      let rawPicks: any[] = [];
      if (Array.isArray(entry.picks)) {
        rawPicks = entry.picks;
      } else if (entry.picks && typeof entry.picks === 'object' && Array.isArray((entry.picks as any).crews)) {
        rawPicks = (entry.picks as any).crews;
      }

      picks = rawPicks.map((p: any) => {
        if (typeof p === "string") return { crewId: p, predictedMargin: 0 };
        return {
          crewId: String(p.crewId || p.crew_id || p.id || ''),
          event_id: p.event_id,
          predictedMargin: p.predictedMargin ?? p.predicted_margin ?? 0,
        };
      });
    } catch (e) {
      console.error("[scoring-logic] Failed to parse picks for entry:", entry.id, e);
      continue;
    }

    let totalPoints = 0;
    let totalMarginError = 0;
    const crewScores: CrewScore[] = [];

    for (const pick of picks) {
      const result = resultMap.get(String(pick.crewId));

      if (result) {
        const finishPoints = getFinishPoints(result.finishOrder);
        totalPoints += finishPoints;

        // Margin error: |predicted - actual signed margin|
        const predictedMargin = pick.predictedMargin || 0;
        const actualMargin = result.calculatedMargin;
        const marginError = Math.abs(predictedMargin - actualMargin);
        totalMarginError += marginError;

        crewScores.push({
          crew_id: pick.crewId,
          event_id: result.eventId,
          predicted_margin: pick.predictedMargin,
          actual_margin: result.calculatedMargin,
          finish_order: result.finishOrder,
          finish_points: finishPoints,
          margin_error: marginError,
        });
      } else {
        console.error("[scoring-logic] No result for crew:", pick.crewId, "entry:", entry.id);
        unmatchedPicks.push({ entryId: entry.id, crewId: pick.crewId, eventId: pick.event_id });
      }
    }

    // Round margin error to avoid floating point issues
    totalMarginError = Math.round(totalMarginError * 100) / 100;

    scores.push({
      entry_id: entry.id,
      user_id: entry.user_id,
      total_points: totalPoints,
      margin_error: totalMarginError,
      crew_scores: crewScores,
    });
  }

  // Hard abort BEFORE any write: a picked crew with no race result means the
  // results set is incomplete (scratched/DNS crews must still get a finish order).
  if (unmatchedPicks.length > 0) {
    const list = unmatchedPicks
      .map((u) => `entry ${u.entryId} → crew ${u.crewId}${u.eventId ? ` (event ${u.eventId})` : ""}`)
      .join("; ");
    throw new Error(
      `[scoring-logic] Refusing to score pool ${contestPoolId}: ${unmatchedPicks.length} pick(s) reference crews with no result: ${list}`,
    );
  }



  // All-zero detection
  const allZero = scores.every((s) => s.total_points === 0);
  if (allZero && scores.length > 0) {
    console.warn("[scoring-logic] WARNING: All entries scored 0 points — picks likely did not match any results. Pool:", contestPoolId);
  }

  // Sort: highest points first; tiebreak on lowest margin error
  scores.sort((a, b) => {
    if (a.total_points !== b.total_points) return b.total_points - a.total_points;
    return a.margin_error - b.margin_error; // lower error wins
  });

  const isH2H = pool.max_entries <= 2;

  // Assign ranks — entries with same points but different margin error get DIFFERENT ranks
  for (let i = 0; i < scores.length; i++) {
    if (i === 0) {
      scores[i].rank = 1;
      scores[i].is_tiebreak_resolved = false;
    } else {
      const prev = scores[i - 1];
      const curr = scores[i];
      // Same rank ONLY if both points AND margin error are identical
      if (prev.total_points === curr.total_points && prev.margin_error === curr.margin_error) {
        scores[i].rank = prev.rank;
        scores[i].is_tiebreak_resolved = false;
      } else if (prev.total_points === curr.total_points) {
        // Points tied but margin broke the tie
        scores[i].rank = i + 1;
        scores[i].is_tiebreak_resolved = true;
      } else {
        scores[i].rank = i + 1;
        scores[i].is_tiebreak_resolved = false;
      }
    }
  }

  const winnerIds = scores.filter((s) => s.rank === 1).map((s) => s.user_id);

  // Payouts
  const prizePoolCents = pool.prize_pool_cents || 0;
  let payoutStructure: Record<number, number> = pool.payout_structure || { 1: prizePoolCents };
  let isTieRefund = false;

  if (isH2H) {
    payoutStructure = { 1: prizePoolCents };

    if (scores.length === 2) {
      const a = scores[0];
      const b = scores[1];
      const isTrueTie = a.total_points === b.total_points && a.margin_error === b.margin_error;

      if (isTrueTie) {
        // TRUE TIE in H2H — settlement will detect via winner_ids=[] and refund entry fees
        console.log("[scoring-logic] H2H TRUE TIE detected — settlement will issue refunds");
        isTieRefund = true;
        for (const score of scores) {
          score.is_winner = false;
          score.rank = 1; // tied at rank 1
          score.is_tie_refund = true;
        }
      } else {
        // Normal H2H: winner takes all (payout computed by settlement)
        for (const score of scores) {
          score.is_winner = score.rank === 1;
        }
      }
    } else {
      // Single entry in H2H — just assign winner flag (payout computed by settlement)
      for (const score of scores) {
        score.is_winner = score.rank === 1;
      }
    }
  } else {
    // Standard contest — payout computed by settlement using sum-and-split rule
    for (const score of scores) {
      score.is_winner = score.rank === 1;
    }
  }

  // Upsert scores — collect any per-entry write failures so we DO NOT flip pool to
  // scoring_completed on stale ranks. Settlement must never run on partial writes.
  const writeErrors: string[] = [];
  for (const score of scores) {
    const { error: upsertError } = await supabase.from("contest_scores").upsert(
      {
        entry_id: score.entry_id,
        pool_id: contestPoolId,
        user_id: score.user_id,
        total_points: score.total_points,
        margin_bonus: score.margin_error, // store margin_error in margin_bonus field
        rank: score.rank,
        // payout_cents intentionally omitted — settlement (settle_contest_pool_atomic) owns payouts
        is_tiebreak_resolved: score.is_tiebreak_resolved ?? false,
        is_winner: score.is_winner ?? false,
        crew_scores: score.crew_scores,
      },
      { onConflict: "entry_id" },
    );

    if (upsertError) {
      console.error("[scoring-logic] Upsert error for entry", score.entry_id, upsertError.message);
      writeErrors.push(`contest_scores upsert failed for entry ${score.entry_id}: ${upsertError.message}`);
    }

    // Update entry
    const { error: entryUpdateError } = await supabase
      .from("contest_entries")
      .update({
        total_points: score.total_points,
        margin_error: score.margin_error,
        rank: score.rank,
        // payout_cents intentionally omitted — settlement (settle_contest_pool_atomic) owns payouts
        status: "active",
      })
      .eq("id", score.entry_id);

    if (entryUpdateError) {
      console.error("[scoring-logic] Entry update error:", score.entry_id, entryUpdateError.message);
      writeErrors.push(`contest_entries update failed for entry ${score.entry_id}: ${entryUpdateError.message}`);
    }
  }

  // Abort BEFORE flipping pool status if any per-entry write failed.
  // Settlement must never run on stale/partial ranks.
  if (writeErrors.length > 0) {
    throw new Error(
      `[scoring-logic] Aborting pool ${contestPoolId} — ${writeErrors.length} per-entry write failure(s). ` +
      `Pool NOT marked scoring_completed. First error: ${writeErrors[0]}`,
    );
  }

  // Mark pool status — precondition guards against racing settle/void clobbering.
  const poolStatus = "scoring_completed";
  const { data: updatedPools, error: poolUpdateError } = await supabase
    .from("contest_pools")
    .update({
      status: poolStatus,
      winner_ids: isTieRefund ? [] : winnerIds,
    })
    .eq("id", contestPoolId)
    .not("status", "in", "(settled,voided,cancelled)")
    .select("id");

  if (poolUpdateError) {
    console.error("[scoring-logic] Pool status update error:", poolUpdateError.message);
    throw new Error(`[scoring-logic] Failed to mark pool ${contestPoolId} scoring_completed: ${poolUpdateError.message}`);
  }

  if (!updatedPools || updatedPools.length === 0) {
    throw new Error(
      `[scoring-logic] Pool ${contestPoolId} reached a terminal status mid-scoring (settled/voided/cancelled) — refusing to clobber`,
    );
  }


  // Compliance log
  await supabase.from("compliance_audit_logs").insert({
    event_type: "contest_scored",
    severity: "info",
    description: `Scored: ${pool.contest_templates?.regatta_name || "Contest"} — pool ${contestPoolId}${isTieRefund ? " (H2H TIE REFUND)" : ""}`,
    metadata: {
      contest_pool_id: contestPoolId,
      entries_scored: scores.length,
      winner_ids: isTieRefund ? [] : winnerIds,
      top_score: scores[0]?.total_points,
      top_margin_error: scores[0]?.margin_error,
      is_tie_refund: isTieRefund,
    },
  });

  console.log("[scoring-logic] Done. Entries scored:", scores.length, "Winners:", winnerIds, "TieRefund:", isTieRefund);

  return { entriesScored: scores.length, winnerId: winnerIds[0], isTieRefund };
}

// ---------------------------------------------------------------------------
// V2 PATH — configurable placement scoring (scoring_config present)
// ---------------------------------------------------------------------------
async function scoreConfiguredPool(
  supabase: any,
  contestPoolId: string,
  pool: any,
  rawCfg: unknown,
): Promise<{ entriesScored: number; winnerId?: string; isTieRefund?: boolean }> {
  const parsed = ScoringConfigSchema.safeParse(rawCfg);
  if (!parsed.success) {
    throw new Error(
      `[scoring-logic] Refusing to score pool ${contestPoolId}: invalid scoring_config: ${
        JSON.stringify(parsed.error.flatten())
      }`,
    );
  }
  const cfg = parsed.data;

  // Defense in depth: survivor outcomes are written ONLY by
  // score_survivor_round_atomic. The handler gates on template primitive, but
  // forceRescore bypasses the status gate, so refuse here too.
  if (cfg.primitive === "survivor") {
    throw new Error("survivor pools are scored via score_survivor_round_atomic");
  }

  const template = pool.contest_templates;
  const templateId = pool.contest_template_id;

  // ---- load the new-path result graph (no PostgREST FK embedding) ----
  const { data: races, error: racesErr } = await supabase
    .from("contest_races")
    .select("id, race_key")
    .eq("template_id", templateId);
  if (racesErr) throw new Error(`Failed to fetch races: ${racesErr.message}`);
  if (!races || races.length === 0) {
    throw new Error(`[scoring-logic] Refusing to score pool ${contestPoolId}: template has no races`);
  }

  const { data: competitors, error: compErr } = await supabase
    .from("contest_competitors")
    .select("id, competitor_key")
    .eq("template_id", templateId);
  if (compErr) throw new Error(`Failed to fetch competitors: ${compErr.message}`);

  const raceIds = races.map((r: any) => r.id);
  const { data: raceEntries, error: reErr } = await supabase
    .from("contest_race_entries")
    .select("race_id, competitor_id")
    .in("race_id", raceIds);
  if (reErr) throw new Error(`Failed to fetch race entries: ${reErr.message}`);

  const { data: raceResults, error: rrErr } = await supabase
    .from("contest_race_results")
    .select("race_id, competitor_id, place, time_ms, status")
    .in("race_id", raceIds);
  if (rrErr) throw new Error(`Failed to fetch race results: ${rrErr.message}`);

  const raceKeyById = new Map<string, string>(races.map((r: any) => [r.id, r.race_key]));
  const compKeyById = new Map<string, string>((competitors || []).map((c: any) => [c.id, c.competitor_key]));

  // Pin statistics to THIS template: ignore any race entry/result whose competitor
  // belongs to a different template (the schema permits it via race_id alone).
  const templateRaceEntries = (raceEntries || []).filter((re: any) => compKeyById.has(re.competitor_id));
  const templateRaceResults = (raceResults || []).filter((rr: any) => compKeyById.has(rr.competitor_id));

  // fieldSize = number of ENTERED competitors per race (not the number of results)
  const fieldSizeByRaceId = new Map<string, number>();
  for (const re of templateRaceEntries) {
    fieldSizeByRaceId.set(re.race_id, (fieldSizeByRaceId.get(re.race_id) ?? 0) + 1);
  }

  // Per-race winner / second / slowest over OK finishers
  const okByRace = new Map<string, any[]>();
  for (const rr of templateRaceResults) {
    if (rr.status !== "OK") continue;
    if (!okByRace.has(rr.race_id)) okByRace.set(rr.race_id, []);
    okByRace.get(rr.race_id)!.push(rr);
  }

  const raceStats = new Map<string, { winner: number | null; second: number | null; slowest: number | null }>();
  for (const raceId of raceIds) {
    const ok = (okByRace.get(raceId) || []).slice().sort((a: any, b: any) => {
      const pa = a.place ?? Number.MAX_SAFE_INTEGER;
      const pb = b.place ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return (a.time_ms ?? Number.MAX_SAFE_INTEGER) - (b.time_ms ?? Number.MAX_SAFE_INTEGER);
    });
    const times = ok.map((r: any) => (r.time_ms === null ? null : Number(r.time_ms)))
      .filter((t: number | null): t is number => t !== null && t > 0);
    raceStats.set(raceId, {
      winner: ok[0] && ok[0].time_ms !== null ? Number(ok[0].time_ms) : null,
      second: ok[1] && ok[1].time_ms !== null ? Number(ok[1].time_ms) : null,
      slowest: times.length > 0 ? Math.max(...times) : null,
    });
  }

  // Result integrity: place must fit in the field and OK rows must have a place
  const resultsByKey: Record<string, RaceResultV2> = {};
  for (const rr of templateRaceResults) {
    const raceKey = raceKeyById.get(rr.race_id);
    const competitorKey = compKeyById.get(rr.competitor_id);
    if (!raceKey || !competitorKey) continue;
    const fieldSize = fieldSizeByRaceId.get(rr.race_id) ?? 0;
    if (rr.status === "OK" && (rr.place === null || rr.place < 1 || rr.place > fieldSize)) {
      throw new Error(
        `[scoring-logic] Refusing to score pool ${contestPoolId}: race ${raceKey} result for ${competitorKey} has invalid place ${rr.place} (field size ${fieldSize})`,
      );
    }
    const stats = raceStats.get(rr.race_id)!;
    resultsByKey[`${raceKey}|${competitorKey}`] = {
      raceKey,
      competitorKey,
      place: rr.place === null ? null : Number(rr.place),
      timeMs: rr.time_ms === null ? null : Number(rr.time_ms),
      status: rr.status,
      fieldSize,
      raceWinnerTimeMs: stats.winner,
      raceSecondTimeMs: stats.second,
      raceSlowestTimeMs: stats.slowest,
    };
  }

  // ---- entries ----
  const { data: entries, error: entriesError } = await supabase
    .from("contest_entries")
    .select("*")
    .eq("pool_id", contestPoolId)
    .in("status", ["active", "scored"]);

  if (entriesError) throw new Error(`Failed to fetch entries: ${entriesError.message}`);
  if (!entries || entries.length === 0) {
    console.log("[scoring-logic] No entries to score for pool:", contestPoolId);
    return { entriesScored: 0 };
  }

  // ---- time_vs_ref branch (placement path below is unchanged) ----
  if (cfg.primitive === "time_vs_ref") {
    const timeCfg = cfg;
    const rosterMode: string = template?.roster_mode ?? "per_race";
    const allRaceKeys: string[] = races.map((r: any) => r.race_key);

    const raceStatsByKey = new Map<string, RaceTimeStats>();
    for (const [raceId, st] of raceStats.entries()) {
      const rk = raceKeyById.get(raceId);
      if (rk) raceStatsByKey.set(rk, { winner: st.winner, slowest: st.slowest });
    }

    // competitor_key → set of race_keys the competitor is entered in
    const enteredByCompetitor = new Map<string, Set<string>>();
    for (const re of templateRaceEntries) {
      const ck = compKeyById.get(re.competitor_id);
      const rk = raceKeyById.get(re.race_id);
      if (!ck || !rk) continue;
      if (!enteredByCompetitor.has(ck)) enteredByCompetitor.set(ck, new Set<string>());
      enteredByCompetitor.get(ck)!.add(rk);
    }

    // Every time_vs_ref contest is fixed-roster.
    const tMinPicks = template?.min_picks ?? null;
    const tMaxPicks = template?.max_picks ?? null;
    if (tMinPicks === null || tMaxPicks === null || tMinPicks !== tMaxPicks) {
      throw new Error(
        `[scoring-logic] Refusing to score pool ${contestPoolId}: fixed roster violated (expected ${tMinPicks} picks)`,
      );
    }

    const timeScores: Array<EntryScore & { total_ms: number; tiebreak_persist: number; margin_bonus: number }> = [];
    const timeFailures: string[] = [];

    for (const entry of entries) {
      const picks = parseEntryPicks(entry);

      if (picks.length !== tMinPicks) {
        throw new Error(
          `[scoring-logic] Refusing to score pool ${contestPoolId}: fixed roster violated (expected ${tMinPicks} picks)`,
        );
      }

      let cells: EntryPick[];
      if (rosterMode === "per_competitor") {
        // GC: every picked competitor is scored across EVERY stage of the template.
        cells = [];
        let missing: string | null = null;
        for (const pick of picks) {
          const entered = enteredByCompetitor.get(pick.crewId) ?? new Set<string>();
          for (const rk of allRaceKeys) {
            if (!entered.has(rk)) {
              missing = `crew ${pick.crewId} is not entered in race ${rk}`;
              break;
            }
            cells.push({ crewId: pick.crewId, event_id: rk, predictedMargin: NaN });
          }
          if (missing) break;
        }
        if (missing) {
          timeFailures.push(`entry ${entry.id} → ${missing}`);
          continue;
        }
      } else {
        cells = picks;
      }

      try {
        const { totalMs, crewScores } = reduceTimeVsRef(cells, resultsByKey, raceStatsByKey, timeCfg);
        const persist = Math.round(totalMs) / 1000;
        timeScores.push({
          entry_id: entry.id,
          user_id: entry.user_id,
          total_points: 0,
          margin_error: persist,
          crew_scores: crewScores,
          total_ms: totalMs,
          tiebreak_persist: Math.round(persist * 1000) / 1000,
          margin_bonus: Math.round(totalMs / 10) / 100,
        });
      } catch (e: any) {
        timeFailures.push(`entry ${entry.id} → ${e.message}`);
      }
    }

    if (timeFailures.length > 0) {
      throw new Error(
        `[scoring-logic] Refusing to score pool ${contestPoolId}: ${timeFailures.length} pick(s) could not be scored: ${timeFailures.join("; ")}`,
      );
    }

    // Bounds check BEFORE any write
    for (const s of timeScores) {
      if (!Number.isFinite(s.total_ms) || !Number.isInteger(s.total_ms) || s.total_ms < 0 || s.total_ms >= 1e11) {
        throw new Error(
          `[scoring-logic] Refusing to score pool ${contestPoolId}: total time out of range for entry ${s.entry_id}`,
        );
      }
      if (!Number.isFinite(s.margin_bonus) || Math.abs(s.margin_bonus) >= 100000000) {
        throw new Error(`[scoring-logic] Refusing to score pool ${contestPoolId}: time value out of numeric(10,2) range`);
      }
    }

    // Lowest total milliseconds wins; equal ms ⇒ shared rank, never "tiebreak resolved".
    timeScores.sort((a, b) => a.total_ms - b.total_ms);

    for (let i = 0; i < timeScores.length; i++) {
      if (i === 0) {
        timeScores[i].rank = 1;
      } else if (timeScores[i - 1].total_ms === timeScores[i].total_ms) {
        timeScores[i].rank = timeScores[i - 1].rank;
      } else {
        timeScores[i].rank = i + 1;
      }
      timeScores[i].is_tiebreak_resolved = false;
    }

    const isH2HTime = pool.max_entries <= 2;
    let timeTieRefund = false;

    if (isH2HTime && timeScores.length === 2 && timeScores[0].total_ms === timeScores[1].total_ms) {
      console.log("[scoring-logic] H2H TRUE TIE detected (time) — settlement will issue refunds");
      timeTieRefund = true;
      for (const score of timeScores) {
        score.is_winner = false;
        score.rank = 1;
        score.is_tie_refund = true;
      }
    } else {
      for (const score of timeScores) score.is_winner = score.rank === 1;
    }

    const timeWinnerIds = timeScores.filter((s) => s.rank === 1).map((s) => s.user_id);

    const timeWriteErrors: string[] = [];
    for (const score of timeScores) {
      const { error: upsertError } = await supabase.from("contest_scores").upsert(
        {
          entry_id: score.entry_id,
          pool_id: contestPoolId,
          user_id: score.user_id,
          total_points: 0,
          margin_bonus: score.margin_bonus,
          rank: score.rank,
          is_tiebreak_resolved: false,
          is_winner: score.is_winner ?? false,
          crew_scores: score.crew_scores,
          score_value: score.total_ms,
          tiebreak_value: score.tiebreak_persist,
        },
        { onConflict: "entry_id" },
      );

      if (upsertError) {
        console.error("[scoring-logic] Upsert error for entry", score.entry_id, upsertError.message);
        timeWriteErrors.push(`contest_scores upsert failed for entry ${score.entry_id}: ${upsertError.message}`);
      }

      const { error: entryUpdateError } = await supabase
        .from("contest_entries")
        .update({
          total_points: 0,
          margin_error: score.tiebreak_persist,
          rank: score.rank,
          status: "active",
        })
        .eq("id", score.entry_id);

      if (entryUpdateError) {
        console.error("[scoring-logic] Entry update error:", score.entry_id, entryUpdateError.message);
        timeWriteErrors.push(`contest_entries update failed for entry ${score.entry_id}: ${entryUpdateError.message}`);
      }
    }

    if (timeWriteErrors.length > 0) {
      throw new Error(
        `[scoring-logic] Aborting pool ${contestPoolId} — ${timeWriteErrors.length} per-entry write failure(s). ` +
          `Pool NOT marked scoring_completed. First error: ${timeWriteErrors[0]}`,
      );
    }

    const { data: updatedTimePools, error: timePoolUpdateError } = await supabase
      .from("contest_pools")
      .update({
        status: "scoring_completed",
        winner_ids: timeTieRefund ? [] : timeWinnerIds,
      })
      .eq("id", contestPoolId)
      .not("status", "in", "(settled,voided,cancelled)")
      .select("id");

    if (timePoolUpdateError) {
      throw new Error(
        `[scoring-logic] Failed to mark pool ${contestPoolId} scoring_completed: ${timePoolUpdateError.message}`,
      );
    }
    if (!updatedTimePools || updatedTimePools.length === 0) {
      throw new Error(
        `[scoring-logic] Pool ${contestPoolId} reached a terminal status mid-scoring (settled/voided/cancelled) — refusing to clobber`,
      );
    }

    await supabase.from("compliance_audit_logs").insert({
      event_type: "contest_scored",
      severity: "info",
      description: `Scored: ${template?.name || template?.regatta_name || "Contest"} — pool ${contestPoolId}${
        timeTieRefund ? " (H2H TIE REFUND)" : ""
      }`,
      metadata: {
        contest_pool_id: contestPoolId,
        entries_scored: timeScores.length,
        winner_ids: timeTieRefund ? [] : timeWinnerIds,
        top_score: timeScores[0]?.total_ms,
        top_tiebreak: timeScores[0]?.tiebreak_persist,
        scoring_primitive: timeCfg.primitive,
        time_ref: timeCfg.time_ref,
        roster_mode: rosterMode,
        tiebreak: timeCfg.tiebreak,
        is_tie_refund: timeTieRefund,
      },
    });

    console.log(
      "[scoring-logic] Done (time_vs_ref). Entries scored:",
      timeScores.length,
      "Winners:",
      timeWinnerIds,
      "TieRefund:",
      timeTieRefund,
    );

    return { entriesScored: timeScores.length, winnerId: timeWinnerIds[0], isTieRefund: timeTieRefund };
  }

  const fixedRosterRequired = cfg.direction === "low" || cfg.tiebreak === "aggregate_time";

  const minPicks = template?.min_picks ?? null;
  const maxPicks = template?.max_picks ?? null;
  if (fixedRosterRequired && (minPicks === null || maxPicks === null || minPicks !== maxPicks)) {
    throw new Error(
      `[scoring-logic] Refusing to score pool ${contestPoolId}: fixed roster violated (expected ${minPicks} picks)`,
    );
  }

  const scores: Array<EntryScore & { tiebreak_cmp: number; tiebreak_persist: number; margin_bonus: number }> = [];
  const failures: string[] = [];

  for (const entry of entries) {
    const picks = parseEntryPicks(entry);

    if (fixedRosterRequired && picks.length !== minPicks) {
      throw new Error(
        `[scoring-logic] Refusing to score pool ${contestPoolId}: fixed roster violated (expected ${minPicks} picks)`,
      );
    }

    try {
      const { totalPoints, tiebreakValue, crewScores } = reducePlacement(picks, resultsByKey, cfg);

      const tiebreakPersist = cfg.tiebreak === "aggregate_time"
        ? Math.round(tiebreakValue) / 1000
        : tiebreakValue;
      const marginBonus = cfg.tiebreak === "aggregate_time"
        ? Math.round(tiebreakValue / 10) / 100
        : tiebreakValue;

      scores.push({
        entry_id: entry.id,
        user_id: entry.user_id,
        total_points: totalPoints,
        margin_error: tiebreakPersist,
        crew_scores: crewScores,
        tiebreak_cmp: tiebreakValue,
        tiebreak_persist: Math.round(tiebreakPersist * 1000) / 1000,
        margin_bonus: marginBonus,
      });
    } catch (e: any) {
      failures.push(`entry ${entry.id} → ${e.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[scoring-logic] Refusing to score pool ${contestPoolId}: ${failures.length} pick(s) could not be scored: ${failures.join("; ")}`,
    );
  }

  // Bounds check BEFORE any write
  for (const s of scores) {
    if (!Number.isFinite(s.total_points) || Math.abs(s.total_points) > 2147483647) {
      throw new Error(`[scoring-logic] Refusing to score pool ${contestPoolId}: total_points out of int32 range`);
    }
    if (!Number.isFinite(s.tiebreak_persist) || Math.abs(s.tiebreak_persist) >= 100000000) {
      throw new Error(`[scoring-logic] Refusing to score pool ${contestPoolId}: tiebreak value out of numeric(10,2) range`);
    }
  }

  // Sort: direction-aware on integer points, then tiebreak ascending
  scores.sort((a, b) => {
    if (a.total_points !== b.total_points) {
      return cfg.direction === "low"
        ? a.total_points - b.total_points
        : b.total_points - a.total_points;
    }
    return a.tiebreak_cmp - b.tiebreak_cmp;
  });

  const isH2H = pool.max_entries <= 2;

  for (let i = 0; i < scores.length; i++) {
    if (i === 0) {
      scores[i].rank = 1;
      scores[i].is_tiebreak_resolved = false;
    } else {
      const prev = scores[i - 1];
      const curr = scores[i];
      if (prev.total_points === curr.total_points && prev.tiebreak_cmp === curr.tiebreak_cmp) {
        scores[i].rank = prev.rank;
        scores[i].is_tiebreak_resolved = false;
      } else if (prev.total_points === curr.total_points) {
        scores[i].rank = i + 1;
        scores[i].is_tiebreak_resolved = true;
      } else {
        scores[i].rank = i + 1;
        scores[i].is_tiebreak_resolved = false;
      }
    }
  }

  const winnerIds = scores.filter((s) => s.rank === 1).map((s) => s.user_id);
  let isTieRefund = false;

  if (isH2H && scores.length === 2) {
    const a = scores[0];
    const b = scores[1];
    const isTrueTie = a.total_points === b.total_points && a.tiebreak_cmp === b.tiebreak_cmp;
    if (isTrueTie) {
      console.log("[scoring-logic] H2H TRUE TIE detected — settlement will issue refunds");
      isTieRefund = true;
      for (const score of scores) {
        score.is_winner = false;
        score.rank = 1;
        score.is_tie_refund = true;
      }
    } else {
      for (const score of scores) score.is_winner = score.rank === 1;
    }
  } else {
    for (const score of scores) score.is_winner = score.rank === 1;
  }

  const writeErrors: string[] = [];
  for (const score of scores) {
    const { error: upsertError } = await supabase.from("contest_scores").upsert(
      {
        entry_id: score.entry_id,
        pool_id: contestPoolId,
        user_id: score.user_id,
        total_points: score.total_points,
        margin_bonus: score.margin_bonus,
        rank: score.rank,
        is_tiebreak_resolved: score.is_tiebreak_resolved ?? false,
        is_winner: score.is_winner ?? false,
        crew_scores: score.crew_scores,
        score_value: score.total_points,
        tiebreak_value: score.tiebreak_persist,
      },
      { onConflict: "entry_id" },
    );

    if (upsertError) {
      console.error("[scoring-logic] Upsert error for entry", score.entry_id, upsertError.message);
      writeErrors.push(`contest_scores upsert failed for entry ${score.entry_id}: ${upsertError.message}`);
    }

    const { error: entryUpdateError } = await supabase
      .from("contest_entries")
      .update({
        total_points: score.total_points,
        margin_error: score.tiebreak_persist,
        rank: score.rank,
        status: "active",
      })
      .eq("id", score.entry_id);

    if (entryUpdateError) {
      console.error("[scoring-logic] Entry update error:", score.entry_id, entryUpdateError.message);
      writeErrors.push(`contest_entries update failed for entry ${score.entry_id}: ${entryUpdateError.message}`);
    }
  }

  if (writeErrors.length > 0) {
    throw new Error(
      `[scoring-logic] Aborting pool ${contestPoolId} — ${writeErrors.length} per-entry write failure(s). ` +
      `Pool NOT marked scoring_completed. First error: ${writeErrors[0]}`,
    );
  }

  const { data: updatedPools, error: poolUpdateError } = await supabase
    .from("contest_pools")
    .update({
      status: "scoring_completed",
      winner_ids: isTieRefund ? [] : winnerIds,
    })
    .eq("id", contestPoolId)
    .not("status", "in", "(settled,voided,cancelled)")
    .select("id");

  if (poolUpdateError) {
    throw new Error(`[scoring-logic] Failed to mark pool ${contestPoolId} scoring_completed: ${poolUpdateError.message}`);
  }
  if (!updatedPools || updatedPools.length === 0) {
    throw new Error(
      `[scoring-logic] Pool ${contestPoolId} reached a terminal status mid-scoring (settled/voided/cancelled) — refusing to clobber`,
    );
  }

  await supabase.from("compliance_audit_logs").insert({
    event_type: "contest_scored",
    severity: "info",
    description: `Scored: ${template?.name || template?.regatta_name || "Contest"} — pool ${contestPoolId}${isTieRefund ? " (H2H TIE REFUND)" : ""}`,
    metadata: {
      contest_pool_id: contestPoolId,
      entries_scored: scores.length,
      winner_ids: isTieRefund ? [] : winnerIds,
      top_score: scores[0]?.total_points,
      top_tiebreak: scores[0]?.tiebreak_persist,
      scoring_primitive: cfg.primitive,
      direction: cfg.direction,
      tiebreak: cfg.tiebreak,
      is_tie_refund: isTieRefund,
    },
  });

  console.log("[scoring-logic] Done (v2). Entries scored:", scores.length, "Winners:", winnerIds, "TieRefund:", isTieRefund);

  return { entriesScored: scores.length, winnerId: winnerIds[0], isTieRefund };
}
