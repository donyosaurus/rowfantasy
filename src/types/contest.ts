// Contest and Draft Types for Multi-Team Fantasy Format

export type ContestType = "H2H" | "5_PERSON";
export type GenderCategory = "Men's" | "Women's";
export type ContestStatus = "open" | "locked" | "completed";

export interface EntryTier {
  id: string;
  type: ContestType;
  entryFee: number;
  prize: number;
  capacity: number;
  filled: number;
}

// Database Types
export interface ContestInstance {
  id: string;
  contest_template_id: string;
  pool_number: string;
  tier_id: string;
  entry_fee_cents: number;
  prize_pool_cents: number;
  max_entries: number;
  min_entries: number;
  current_entries: number;
  lock_time: string;
  status: ContestStatus;
  locked_at: string | null;
  completed_at: string | null;
  settled_at: string | null;
  metadata: Record<string, any>;
  created_at: string;
  contest_templates?: {
    regatta_name: string;
    gender_category: string;
  };
}

export interface ContestScore {
  id: string;
  entry_id: string;
  pool_id: string;
  user_id: string;
  total_points: number;
  margin_bonus: number;
  rank: number | null;
  payout_cents: number;
  is_winner: boolean;
  is_tiebreak_resolved: boolean;
  crew_scores: CrewScore[];
  created_at: string;
  updated_at: string;
  profiles?: {
    username: string;
  };
}

export interface CrewScore {
  crew_id: string;
  division_id: string;
  predicted_margin: number;
  actual_margin?: number;
  finish_position: number | null;
  finish_points: number;
  margin_bonus: number;
}

export interface RaceResult {
  crewId: string;
  crewName: string;
  divisionId: string;
  divisionName: string;
  finishPosition: number;
  finishTime?: string;
  marginSeconds?: number;
}

export interface Division {
  id: string;
  name: string;
  boatClass: string; // e.g., "Varsity 8+", "Lightweight 4+"
  category: string; // e.g., "Heavyweight", "Lightweight"
}

export interface Crew {
  id: string;
  name: string;
  institution: string;
  divisionId: string;
  seedPosition?: number;
}

export interface DraftPick {
  crewId: string;
  divisionId: string;
  predictedMargin: number; // seconds relative to 2nd place (tie-breaker only)
}

export interface Regatta {
  id: string;
  regattaName: string;
  genderCategory: GenderCategory; // Men's or Women's only
  lockTime: string;
  minPicks: number; // minimum 2
  maxPicks: number; // typically 2-4
  divisions: Division[];
  crews: Crew[];
  entryTiers: EntryTier[]; // The 5 entry options
}

export interface Contest {
  id: string;
  regattaId: string;
  tierId: string;
  userId: string;
}

export interface ContestEntry {
  userId: string;
  contestId: string;
  picks: DraftPick[];
  totalPoints: number;
  marginError: number;
  rank?: number;
}

// Finish position scoring
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
