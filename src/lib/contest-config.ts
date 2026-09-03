/**
 * Shared multi-sport contest configuration helpers (frontend only).
 * Mirrors the backend scoring-config contract so the UI can validate early
 * and render sport-appropriate copy. The backend re-validates everything.
 */

export type ContestTypeKey =
  | "classic"
  | "classic_total_time"
  | "low_score"
  | "gc_pool"
  | "team_time_trial"
  | "deficit"
  | "survivor"
  | "podium_predictor";


export interface PlacementScoringConfig {
  primitive: "placement";
  points_table: Record<string, number>;
  direction: "high" | "low";
  dnf_policy: "zero" | "field_plus_one";
  tiebreak: "margin_error" | "aggregate_time" | "none";
}

export interface TimeVsRefScoringConfig {
  primitive: "time_vs_ref";
  time_ref: "none" | "winner";
  dnf_policy: "penalty_pct";
  penalty_pct: number;
  tiebreak: "none";
}

export interface SurvivorScoringConfig {
  primitive: "survivor";
  points_table: Record<string, number>;
  direction: "high";
  dnf_policy: "zero";
  tiebreak: "none";
}

export type ScoringConfig =
  | PlacementScoringConfig
  | TimeVsRefScoringConfig
  | SurvivorScoringConfig;


const CLASSIC_POINTS_TABLE: Record<string, number> = {
  "1": 100,
  "2": 75,
  "3": 60,
  "4": 45,
  "5": 30,
  "6": 15,
  "7": 10,
};

export const CONTEST_TYPES: {
  key: ContestTypeKey;
  label: string;
  subtitle: string;
  fixedRoster: boolean;
  requiresEventClass: boolean;
  perCompetitor?: boolean;
  /** Survivor only: multi-round elimination with a rounds builder. */
  rounds?: boolean;
}[] = [
  {
    key: "classic",
    label: "Classic",
    subtitle: "Place points + margin-prediction tiebreak — same as today's contests",
    fixedRoster: false,
    requiresEventClass: false,
  },
  {
    key: "classic_total_time",
    label: "Total Time",
    subtitle:
      "Place points; ties broken by lowest combined time — fixed roster, same-distance races only",
    fixedRoster: true,
    requiresEventClass: true,
  },
  {
    key: "low_score",
    label: "Low Score",
    subtitle: "Sum of finish places — lowest total wins, like cross-country team scoring",
    fixedRoster: true,
    requiresEventClass: false,
  },
  {
    key: "gc_pool",
    label: "GC / Stage Race",
    subtitle: "Lowest combined time across all stages — pick riders, every stage counts",
    fixedRoster: true,
    requiresEventClass: true,
    perCompetitor: true,
  },
  {
    key: "team_time_trial",
    label: "Team Time Trial",
    subtitle: "Lowest combined time wins — fixed roster, same-distance races only",
    fixedRoster: true,
    requiresEventClass: true,
  },
  {
    key: "deficit",
    label: "Deficit",
    subtitle: "Lowest combined time behind the winners — works across mixed distances",
    fixedRoster: true,
    requiresEventClass: false,
  },
  {
    key: "survivor",
    label: "Survivor",
    subtitle: "Multi-round elimination — survive each round to advance; last entry standing wins",
    fixedRoster: true,
    requiresEventClass: false,
    rounds: true,
  },
];

export function getScoringPreset(key: ContestTypeKey): ScoringConfig {
  if (key === "low_score") {
    return {
      primitive: "placement",
      points_table: {},
      direction: "low",
      dnf_policy: "field_plus_one",
      tiebreak: "none",
    };
  }
  if (key === "survivor") {
    return {
      primitive: "survivor",
      points_table: { ...CLASSIC_POINTS_TABLE },
      direction: "high",
      dnf_policy: "zero",
      tiebreak: "none",
    };
  }
  if (key === "gc_pool" || key === "team_time_trial") {
    return {
      primitive: "time_vs_ref",
      time_ref: "none",
      dnf_policy: "penalty_pct",
      penalty_pct: 10,
      tiebreak: "none",
    };
  }
  if (key === "deficit") {
    return {
      primitive: "time_vs_ref",
      time_ref: "winner",
      dnf_policy: "penalty_pct",
      penalty_pct: 10,
      tiebreak: "none",
    };
  }
  if (key === "classic_total_time") {
    return {
      primitive: "placement",
      points_table: { ...CLASSIC_POINTS_TABLE },
      direction: "high",
      dnf_policy: "zero",
      tiebreak: "aggregate_time",
    };
  }
  return {
    primitive: "placement",
    points_table: { ...CLASSIC_POINTS_TABLE },
    direction: "high",
    dnf_policy: "zero",
    tiebreak: "margin_error",
  };
}


export const SPORT_OPTIONS = [
  "rowing",
  "swimming",
  "cycling",
  "running",
  "track",
  "triathlon",
  "cross-country",
  "other",
];

export const GENDER_OPTIONS = ["Men's", "Women's", "Mixed", "Open"] as const;
export type GenderCategory = (typeof GENDER_OPTIONS)[number];

export interface ContestTerms {
  competitor: string;
  competitors: string;
  Competitor: string;
  Competitors: string;
  event: string;
  events: string;
  Event: string;
  Events: string;
}

const ROWING_TERMS: ContestTerms = {
  competitor: "crew",
  competitors: "crews",
  Competitor: "Crew",
  Competitors: "Crews",
  event: "event",
  events: "events",
  Event: "Event",
  Events: "Events",
};

const GENERIC_TERMS: ContestTerms = {
  competitor: "competitor",
  competitors: "competitors",
  Competitor: "Competitor",
  Competitors: "Competitors",
  event: "race",
  events: "races",
  Event: "Race",
  Events: "Races",
};

/** Sport-aware nouns for user-visible copy. Rowing keeps today's wording. */
export function terms(sport?: string | null): ContestTerms {
  if (!sport || sport === "rowing") return ROWING_TERMS;
  return GENERIC_TERMS;
}

/** Parse `M:SS.cc`, `MM:SS.mmm`, or plain seconds into integer milliseconds. */
export function parseRaceTimeToMs(input: string): number | null {
  const s = (input || "").trim();
  if (!s) return null;
  const m = /^(?:(\d{1,3}):)?([0-5]?\d)(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const mins = m[1] ? parseInt(m[1], 10) : 0;
  const secs = parseInt(m[2], 10);
  const frac = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
  return mins * 60000 + secs * 1000 + frac;
}

/** Format integer milliseconds back to `M:SS.cc`. */
export function formatMsAsRaceTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  const total = Math.max(0, Math.round(Number(ms)));
  const cs = Math.round(total / 10);
  const mins = Math.floor(cs / 6000);
  const secs = (cs % 6000) / 100;
  return `${mins}:${secs.toFixed(2).padStart(5, "0")}`;
}

