// Shared Scoring Logic - Extracted for direct use without HTTP calls

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
  predicted_margin: number;
  actual_margin?: number;
  finish_order: number | null;
  finish_points: number;
  margin_error: number;
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

  // Fetch all active entries for this pool
  const { data: entries, error: entriesError } = await supabase
    .from("contest_entries")
    .select("*")
    .eq("pool_id", contestPoolId)
    .in("status", ["active", "confirmed", "scored"]);

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
        console.warn("[scoring-logic] No result for crew:", pick.crewId);
        crewScores.push({
          crew_id: pick.crewId,
          event_id: pick.event_id,
          predicted_margin: pick.predictedMargin,
          finish_order: null,
          finish_points: 0,
          margin_error: 0,
        });
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
        // TRUE TIE in H2H — refund both users their entry fee
        console.log("[scoring-logic] H2H TRUE TIE detected — refunding entry fees");
        isTieRefund = true;
        for (const score of scores) {
          score.payout_cents = pool.entry_fee_cents || 0; // refund entry fee
          score.is_winner = false;
          score.rank = 1; // tied at rank 1
          score.is_tie_refund = true;
        }
      } else {
        // Normal H2H: winner takes all
        for (const score of scores) {
          score.payout_cents = score.rank === 1 ? prizePoolCents : 0;
          score.is_winner = score.rank === 1;
        }
      }
    } else {
      // Single entry in H2H — just assign
      for (const score of scores) {
        score.payout_cents = score.rank === 1 ? prizePoolCents : 0;
        score.is_winner = score.rank === 1;
      }
    }
  } else {
    // Standard contest payouts
    for (const score of scores) {
      score.payout_cents = payoutStructure[score.rank!] || 0;
      score.is_winner = score.rank === 1;
    }
  }

  // Upsert scores
  for (const score of scores) {
    const { error: upsertError } = await supabase.from("contest_scores").upsert(
      {
        entry_id: score.entry_id,
        pool_id: contestPoolId,
        user_id: score.user_id,
        total_points: score.total_points,
        margin_bonus: score.margin_error, // store margin_error in margin_bonus field
        rank: score.rank,
        payout_cents: score.payout_cents,
        is_tiebreak_resolved: score.is_tiebreak_resolved ?? false,
        is_winner: score.is_winner ?? false,
        crew_scores: score.crew_scores,
      },
      { onConflict: "entry_id" },
    );

    if (upsertError) {
      console.error("[scoring-logic] Upsert error for entry", score.entry_id, upsertError.message);
    }

    // Update entry
    const { error: entryUpdateError } = await supabase
      .from("contest_entries")
      .update({
        total_points: score.total_points,
        margin_error: score.margin_error,
        rank: score.rank,
        payout_cents: score.payout_cents,
        status: "active",
      })
      .eq("id", score.entry_id);

    if (entryUpdateError) {
      console.error("[scoring-logic] Entry update error:", score.entry_id, entryUpdateError.message);
    }
  }

  // Mark pool status
  const poolStatus = isTieRefund ? "scoring_completed" : "scoring_completed";
  const { error: poolUpdateError } = await supabase
    .from("contest_pools")
    .update({
      status: poolStatus,
      winner_ids: isTieRefund ? [] : winnerIds,
      // Store tie_refund flag in pool metadata if needed by settlement
    })
    .eq("id", contestPoolId);

  if (poolUpdateError) {
    console.error("[scoring-logic] Pool status update error:", poolUpdateError.message);
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
