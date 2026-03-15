export interface MatchupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  poolId: string;
  currentUserId: string;
  contestName: string;
  poolStatus: string;
  lockTime: string;
  maxEntries: number;
  currentEntries: number;
  payoutStructure: Record<string, number> | null;
}

export interface EntrantRow {
  id: string;
  user_id: string;
  username: string | null;
  picks: unknown;
  total_points: number | null;
  margin_error: number | null;
  rank: number | null;
  payout_cents: number | null;
  status: string;
  created_at: string;
  score?: {
    total_points: number;
    margin_bonus: number;
    rank: number | null;
    payout_cents: number | null;
    is_winner: boolean | null;
    crew_scores: unknown;
  };
}

export interface CrewInfo {
  crew_id: string;
  crew_name: string;
  event_id: string;
}

export interface ParsedPick {
  crewName: string;
  crewId: string;
  margin: number | null;
  eventId: string;
}
