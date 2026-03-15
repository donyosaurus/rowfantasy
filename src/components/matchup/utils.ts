import { formatCents } from "@/lib/formatCurrency";
import type { CrewInfo, ParsedPick, EntrantRow } from "./types";

export function parsePicks(picks: unknown, crewMap: Map<string, CrewInfo>): ParsedPick[] {
  if (!picks) return [];
  let parsed = picks;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }

  let arr: unknown[];
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "crews" in (parsed as any)) {
    arr = Array.isArray((parsed as any).crews) ? (parsed as any).crews : [];
  } else if (Array.isArray(parsed)) {
    arr = parsed;
  } else {
    return [];
  }

  return arr.map((pick) => {
    if (typeof pick === "object" && pick !== null && "crewId" in pick) {
      const p = pick as { crewId: string; predictedMargin: number };
      const crew = crewMap.get(p.crewId);
      return { crewName: crew?.crew_name || p.crewId, crewId: p.crewId, margin: p.predictedMargin, eventId: crew?.event_id || "" };
    }
    if (typeof pick === "string") {
      const crew = crewMap.get(pick);
      return { crewName: crew?.crew_name || pick, crewId: pick, margin: null, eventId: crew?.event_id || "" };
    }
    return { crewName: "Unknown", crewId: "", margin: null, eventId: "" };
  });
}

export function getRankLabel(r: number): string {
  if (r === 1) return "1st";
  if (r === 2) return "2nd";
  if (r === 3) return "3rd";
  return `${r}th`;
}

export function getPrizeLines(payoutStructure: Record<string, number> | null): string {
  if (!payoutStructure) return "";
  const sorted = Object.entries(payoutStructure).sort(([a], [b]) => Number(a) - Number(b));
  return sorted.map(([rank, cents]) => `${getRankLabel(Number(rank))}: ${formatCents(cents)}`).join(" · ");
}

export function getEntrantData(entrant: EntrantRow) {
  return {
    rank: entrant.score?.rank ?? entrant.rank,
    points: entrant.score?.total_points ?? entrant.total_points,
    marginError: entrant.score?.margin_bonus ?? entrant.margin_error,
    payout: entrant.score?.payout_cents ?? entrant.payout_cents,
    isWinner: entrant.score?.is_winner || false,
  };
}

export function formatEventId(eventId: string): string {
  return eventId
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
