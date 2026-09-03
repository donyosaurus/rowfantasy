// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { useParams, Link, useNavigate } from "react-router-dom";
import { CrewLogo } from "@/components/CrewLogo";
import { DraftPicksList } from "@/components/DraftPicksList";
import { CrewCard } from "@/components/CrewCard";
import { DraftPageBackground } from "@/components/DraftPageBackground";
import { useEffect, useState, useMemo, useRef } from "react";
import { invokeGeoFunction } from "@/integrations/supabase/geoFunctions";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Loader2,
  Trophy,
  Zap,
  ChevronDown,
  Lock,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatCents } from "@/lib/formatCurrency";
import { TierSelector, type EntryTier } from "@/components/TierSelector";
import { ContestBannerHeader } from "@/components/ContestBannerHeader";
import { terms } from "@/lib/contest-config";

interface PoolCrew {
  id: string;
  crew_id: string;
  crew_name: string;
  event_id: string;
  logo_url?: string | null;
}

interface ScoringConfigLite {
  primitive?: string;
  time_ref?: string;
  points_table?: Record<string, number>;
  direction?: string;
  tiebreak?: string;
}

/** Survivor-only shapes — unused by every other contest primitive. */
interface SurvivorRace {
  race_key: string;
  name: string | null;
  round_no: number | null;
  race_order: number;
  competitors: { crew_id: string; crew_name: string; logo_url: string | null }[];
}

interface SurvivorRound {
  round_no: number;
  lock_at: string;
  advance_count: number;
  status: string;
}

interface SurvivorEntryRound {
  round_no: number;
  picks: unknown;
  points: number | null;
  round_rank: number | null;
  advanced: boolean | null;
}


interface ContestPool {
  id: string;
  lock_time: string;
  status: string;
  entry_fee_cents: number;
  max_entries: number;
  current_entries: number;
  prize_pool_cents: number;
  payout_structure: Record<string, number> | null;
  contest_template_id: string;
  tier_id: string;
  allow_overflow?: boolean;
  entry_tiers: EntryTier[] | null;
  contest_templates: {
    id: string;
    regatta_name: string;
    gender_category: string;
    min_picks: number;
    max_picks: number;
    card_banner_url?: string | null;
    draft_banner_url?: string | null;
    sport?: string | null;
    name?: string | null;
    scoring_config?: ScoringConfigLite | null;
    roster_mode?: string | null;
    roster_tiers?: { name: string; competitors: string[] }[] | null;


  };
  contest_pool_crews: PoolCrew[];
}

const FINISH_POINTS: Record<number, number> = {
  1: 100, 2: 75, 3: 60, 4: 45, 5: 30, 6: 15, 7: 10,
};
const DEFAULT_POINTS = 0;

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const TIER_ACCENT: Record<string, string> = {
  Bronze: "border-l-amber-600 bg-amber-500/5",
  Silver: "border-l-slate-400 bg-slate-300/5",
  Gold: "border-l-yellow-500 bg-yellow-400/5",
};

const RegattaDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [contestPool, setContestPool] = useState<ContestPool | null>(null);
  const [allTemplatePools, setAllTemplatePools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Picks are keyed by the composite `${crew_id}::${event_id}` — a v2 competitor can
  // appear in more than one race, so crew_id alone is not a unique pick identity.
  // Exception: per_competitor (GC) rosters key by crew_id alone (one pick per competitor).
  const [crewPicks, setCrewPicks] = useState<Map<string, { crewId: string; eventId: string; margin: number; position?: number; weight?: number }>>(new Map());
  // Ordered stages for per_competitor (GC) templates — read-only display.
  const [stageList, setStageList] = useState<{ race_key: string; name: string | null }[]>([]);


  const [submitting, setSubmitting] = useState(false);
  const [scoringOpen, setScoringOpen] = useState(false);
  const [prizePoolOpen, setPrizePoolOpen] = useState(false);
  // Wave 1 #6: balance via fail-closed centralized RPC.
  const wallet = useWalletBalance();
  const walletBalanceCents: number | null = wallet.status === 'ready' ? wallet.availableCents : null;
  const [selectedTier, setSelectedTier] = useState<EntryTier | null>(null);

  // ── Survivor (primitive === 'survivor') state. Unused by every other contest type. ──
  const [survivorRaces, setSurvivorRaces] = useState<SurvivorRace[]>([]);
  const [survivorRounds, setSurvivorRounds] = useState<SurvivorRound[]>([]);
  const [survivorEntry, setSurvivorEntry] = useState<{ id: string; status: string } | null>(null);
  const [survivorEntryRounds, setSurvivorEntryRounds] = useState<SurvivorEntryRound[]>([]);
  const [roundPicks, setRoundPicks] = useState<Map<string, string>>(new Map()); // race_key -> crew_id
  const [roundSubmitting, setRoundSubmitting] = useState(false);
  const [survivorRefreshKey, setSurvivorRefreshKey] = useState(0);
  const roundSubmitRef = useRef(false);

  useEffect(() => {
    if (!id) { setError("No contest ID provided"); setLoading(false); return; }
    const fetchPoolData = async () => {
      const { data, error: fetchError } = await supabase
        .from("contest_pools")
        .select(`id, contest_template_id, created_at, current_entries, entry_fee_cents, entry_tiers, lock_time, max_entries, payout_structure, prize_pool_cents, prize_structure, settled_at, status, tier_id, tier_name, allow_overflow, void_unfilled_on_settle, contest_templates!inner (id, regatta_name, gender_category, min_picks, max_picks, card_banner_url, draft_banner_url, sport, name, scoring_config, roster_mode, roster_tiers), contest_pool_crews (id, crew_id, crew_name, event_id, logo_url)`)
        .eq("id", id)
        .single();
      if (fetchError || !data) { setError("Contest not found"); setLoading(false); return; }

      const pool = data as unknown as ContestPool;
      const isSurvivorTemplate =
        (pool.contest_templates?.scoring_config as ScoringConfigLite | null)?.primitive === "survivor";

      // Multi-race (v2) templates carry no contest_pool_crews rows — rebuild the same
      // structure from the engine tables. Legacy/single-race contests skip this entirely.
      // Survivor templates ALWAYS load the graph (rounds 2+ need it even when crews exist).
      const needsCrewRebuild = !pool.contest_pool_crews || pool.contest_pool_crews.length === 0;
      if (needsCrewRebuild || isSurvivorTemplate) {
        const templateId = pool.contest_template_id;
        const [racesRes, compsRes] = await Promise.all([
          supabase
            .from("contest_races")
            .select("id, race_key, name, race_order, round_no")
            .eq("template_id", templateId)
            .order("race_order", { ascending: true }),
          supabase
            .from("contest_competitors")
            .select("id, competitor_key, name, logo_url")
            .eq("template_id", templateId),
        ]);
        if (racesRes.error || compsRes.error) {
          console.error("Failed to load contest races/competitors", racesRes.error || compsRes.error);
          setError("Failed to load contest lineup");
          setLoading(false);
          return;
        }
        const races = racesRes.data || [];
        const comps = compsRes.data || [];

        if (isSurvivorTemplate) {
          // Survivor: build the full race graph and always assign ONLY round-1 crews
          // to the entry grid, regardless of whether the pool has materialized rows.
          if (races.length > 0 && comps.length > 0) {
            const { data: entryRows, error: entriesError } = await supabase
              .from("contest_race_entries")
              .select("race_id, competitor_id")
              .in("race_id", races.map((r) => r.id));
            if (entriesError) {
              console.error("Failed to load contest race entries", entriesError);
              setError("Failed to load contest lineup");
              setLoading(false);
              return;
            }
            const raceKeyById = new Map(races.map((r) => [r.id, r.race_key]));
            const raceOrderById = new Map(races.map((r, i) => [r.id, i]));
            const compById = new Map(comps.map((c) => [c.id, c]));
            const builtCrews: PoolCrew[] = (entryRows || [])
              .slice()
              .sort((a, b) => (raceOrderById.get(a.race_id) ?? 0) - (raceOrderById.get(b.race_id) ?? 0))
              .map((re) => {
                const c = compById.get(re.competitor_id);
                return {
                  id: `${re.race_id}-${re.competitor_id}`,
                  crew_id: c?.competitor_key ?? "",
                  crew_name: c?.name ?? c?.competitor_key ?? "",
                  event_id: raceKeyById.get(re.race_id) ?? "",
                  logo_url: c?.logo_url ?? null,
                };
              })
              .filter((c) => c.crew_id && c.event_id);

            const byRaceKey = new Map<string, PoolCrew[]>();
            for (const c of builtCrews) {
              if (!byRaceKey.has(c.event_id)) byRaceKey.set(c.event_id, []);
              byRaceKey.get(c.event_id)!.push(c);
            }
            const graph: SurvivorRace[] = races.map((r: any) => ({
              race_key: r.race_key,
              name: r.name ?? null,
              round_no: r.round_no ?? null,
              race_order: r.race_order,
              competitors: (byRaceKey.get(r.race_key) || []).map((c) => ({
                crew_id: c.crew_id,
                crew_name: c.crew_name,
                logo_url: c.logo_url ?? null,
              })),
            }));
            setSurvivorRaces(graph);

            const roundOneKeys = new Set(
              races.filter((r: any) => r.round_no === 1).map((r: any) => r.race_key)
            );
            pool.contest_pool_crews = builtCrews.filter((c) => roundOneKeys.has(c.event_id));
          } else {
            setSurvivorRaces([]);
            pool.contest_pool_crews = [];
          }
        } else if (needsCrewRebuild && races.length > 0 && comps.length > 0) {
          setStageList(races.map((r: any) => ({ race_key: r.race_key, name: r.name ?? null })));
          const { data: entryRows, error: entriesError } = await supabase
            .from("contest_race_entries")
            .select("race_id, competitor_id")
            .in("race_id", races.map((r) => r.id));
          if (entriesError) {
            console.error("Failed to load contest race entries", entriesError);
            setError("Failed to load contest lineup");
            setLoading(false);
            return;
          }
          const raceKeyById = new Map(races.map((r) => [r.id, r.race_key]));
          const raceOrderById = new Map(races.map((r, i) => [r.id, i]));
          const compById = new Map(comps.map((c) => [c.id, c]));
          const builtCrews: PoolCrew[] = (entryRows || [])
            .slice()
            .sort((a, b) => (raceOrderById.get(a.race_id) ?? 0) - (raceOrderById.get(b.race_id) ?? 0))
            .map((re) => {
              const c = compById.get(re.competitor_id);
              return {
                id: `${re.race_id}-${re.competitor_id}`,
                crew_id: c?.competitor_key ?? "",
                crew_name: c?.name ?? c?.competitor_key ?? "",
                event_id: raceKeyById.get(re.race_id) ?? "",
                logo_url: c?.logo_url ?? null,
              };
            })
            .filter((c) => c.crew_id && c.event_id);
          pool.contest_pool_crews = builtCrews;
        }
      }



      // Fetch ALL pools for this template to detect tiers
      const { data: allPools } = await supabase
        .from("contest_pools")
        .select("id, tier_name, entry_fee_cents, payout_structure, current_entries, max_entries, status, allow_overflow")
        .eq("contest_template_id", pool.contest_template_id)
        .order("entry_fee_cents", { ascending: true });

      setAllTemplatePools(allPools || []);

      const tierPools = (allPools || []).filter((p: any) => p.tier_name);
      if (tierPools.length > 1) {
        const tiers: EntryTier[] = [];
        const seenTiers = new Set<string>();
        for (const tp of tierPools) {
          if (seenTiers.has(tp.tier_name)) continue;
          seenTiers.add(tp.tier_name);
          tiers.push({
            name: tp.tier_name,
            entry_fee_cents: tp.entry_fee_cents,
            payout_structure: (tp.payout_structure as Record<string, number>) || {},
          });
        }
        tiers.sort((a, b) => a.entry_fee_cents - b.entry_fee_cents);
        (pool as any).entry_tiers = tiers;
      }

      if (isSurvivorTemplate) {
        const { data: roundRows, error: roundsError } = await supabase
          .from("contest_rounds")
          .select("round_no, lock_at, advance_count, status")
          .eq("template_id", pool.contest_template_id)
          .order("round_no", { ascending: true });
        if (roundsError) {
          console.error("Failed to load survivor rounds", roundsError);
          setError("Failed to load contest rounds");
          setLoading(false);
          return;
        }
        setSurvivorRounds((roundRows || []) as SurvivorRound[]);
      }

      setContestPool(pool);
      setLoading(false);
    };
    fetchPoolData();
  }, [id]);

  // Owner-scoped survivor reads. Keyed by user?.id so they re-run once auth resolves.
  useEffect(() => {
    const poolId = contestPool?.id;
    const isSurvivorTemplate =
      (contestPool?.contest_templates?.scoring_config as ScoringConfigLite | null)?.primitive === "survivor";

    setSurvivorEntry(null);
    setSurvivorEntryRounds([]);
    setRoundPicks(new Map());

    if (!poolId || !isSurvivorTemplate) return;
    if (authLoading) return;
    if (!user) { setSurvivorEntry(null); setSurvivorEntryRounds([]); setRoundPicks(new Map()); return; }

    let cancelled = false;
    const loadOwnerData = async () => {
      const { data: entryRow, error: entryError } = await supabase
        .from("contest_entries")
        .select("id, status")
        .eq("pool_id", poolId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (entryError) {
        setSurvivorEntry(null);
        setSurvivorEntryRounds([]);
        setRoundPicks(new Map());
        console.error("Failed to load survivor entry", entryError);
        toast.error("Failed to load your elimination-round status");
        return;
      }
      if (!entryRow) { setSurvivorEntry(null); setSurvivorEntryRounds([]); setRoundPicks(new Map()); return; }
      setSurvivorEntry(entryRow as { id: string; status: string });

      const { data: erRows, error: erError } = await supabase
        .from("contest_entry_rounds")
        .select("round_no, picks, points, round_rank, advanced")
        .eq("entry_id", entryRow.id)
        .order("round_no", { ascending: true });
      if (cancelled) return;
      if (erError) {
        setSurvivorEntryRounds([]);
        setRoundPicks(new Map());
        console.error("Failed to load survivor entry rounds", erError);
        toast.error("Failed to load your round history");
        return;
      }
      setSurvivorEntryRounds((erRows || []) as unknown as SurvivorEntryRound[]);
    };
    loadOwnerData();
    return () => { cancelled = true; };
  }, [contestPool?.id, contestPool?.contest_templates?.scoring_config, user?.id, authLoading, survivorRefreshKey]);


  // (Wave 1 #6) Direct .from('wallets') read removed — useWalletBalance hook
  // handles the load through get_user_wallet_balances() RPC.

  const crewsByDivision = useMemo(() => {
    if (!contestPool?.contest_pool_crews) return {};
    const grouped: Record<string, PoolCrew[]> = {};
    for (const crew of contestPool.contest_pool_crews) {
      if (!grouped[crew.event_id]) grouped[crew.event_id] = [];
      grouped[crew.event_id].push(crew);
    }
    return grouped;
  }, [contestPool?.contest_pool_crews]);

  const divisions = Object.keys(crewsByDivision);

  const template = contestPool?.contest_templates;
  const scoringConfig = template?.scoring_config ?? null;
  // GC / stage races: one roster of competitors, every stage counts.
  const isPerCompetitor = !!scoringConfig && template?.roster_mode === "per_competitor";
  const isTimeScored = scoringConfig?.primitive === "time_vs_ref";
  const isSurvivor = scoringConfig?.primitive === "survivor";
  // Podium Predictor: ordered picks from a single race.
  const isPrediction = scoringConfig?.primitive === "prediction";
  // Confidence Pick'em: per-race picks ranked 1..N by confidence.
  const isConfidence = !!(scoringConfig as any)?.confidence;
  const podiumSize = Number.isInteger((scoringConfig as any)?.podium_size) && (scoringConfig as any).podium_size > 0
    ? Number((scoringConfig as any).podium_size)
    : 3;

  // Tiers: pick exactly one competitor from each tier.
  const rosterTiers = (Array.isArray(template?.roster_tiers) && template!.roster_tiers!.length > 0)
    ? template!.roster_tiers!
    : null;
  const isTierPick = !!rosterTiers;
  const tierOfCompetitor = useMemo(() => {
    const map = new Map<string, number>();
    if (rosterTiers) {
      rosterTiers.forEach((tier, i) => {
        (tier.competitors || []).forEach((k) => { if (!map.has(k)) map.set(k, i); });
      });
    }
    return map;
  }, [rosterTiers]);




  const sport = template?.sport ?? null;
  const t = terms(sport);
  const displayName = template?.name || template?.regatta_name || "";
  // Legacy templates (null scoring_config) always need a margin prediction.
  const needsMargin = !scoringConfig || scoringConfig.tiebreak === "margin_error";
  const scoringPointsRows: [string, number][] = Object.entries(
    scoringConfig?.points_table && Object.keys(scoringConfig.points_table).length > 0
      ? scoringConfig.points_table
      : (FINISH_POINTS as unknown as Record<string, number>)
  ).sort((a, b) => Number(a[0]) - Number(b[0]));

  // Deduped competitor list for per_competitor mode (first race_order appearance wins).
  const competitorList = useMemo(() => {
    if (!isPerCompetitor || !contestPool?.contest_pool_crews) return [] as PoolCrew[];
    const seen = new Set<string>();
    const out: PoolCrew[] = [];
    for (const c of contestPool.contest_pool_crews) {
      if (seen.has(c.crew_id)) continue;
      seen.add(c.crew_id);
      out.push(c);
    }
    return out;
  }, [isPerCompetitor, contestPool?.contest_pool_crews]);

  const pickKey = (crewId: string, eventId: string) => (isPerCompetitor ? crewId : `${crewId}::${eventId}`);

  const toggleCrewSelection = (crewId: string, eventId: string) => {
    const key = pickKey(crewId, eventId);

    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      if (newPicks.has(key)) {
        newPicks.delete(key);
        if (isPrediction) {
          // Renumber remaining podium slots in their existing order.
          const rebuilt = new Map<string, { crewId: string; eventId: string; margin: number; position?: number }>();
          let i = 0;
          for (const [k, v] of newPicks) {
            i += 1;
            rebuilt.set(k, { ...v, position: i });
          }
          return rebuilt;
        }
        return newPicks;
      }
      if (isPrediction) {
        // Podium Predictor: multiple crews from the same race, ordered 1..podium_size.
        if (newPicks.size >= podiumSize) { toast.error(`Maximum ${podiumSize} picks allowed`); return prev; }
        newPicks.set(key, { crewId, eventId, margin: 0, position: newPicks.size + 1 });
        return newPicks;
      }
      if (isTierPick) {
        // Tiers: one pick per tier — swap out any existing pick from the same tier.
        const tierIdx = tierOfCompetitor.get(crewId);
        if (tierIdx === undefined) return prev;
        for (const [k, v] of newPicks) {
          if (tierOfCompetitor.get(v.crewId) === tierIdx) { newPicks.delete(k); break; }
        }
        newPicks.set(key, { crewId, eventId: "", margin: 0 });
        return newPicks;
      }
      if (isPerCompetitor) {

        // GC: a flat roster, no per-race swap.
        if (newPicks.size >= maxPicks) { toast.error(`Maximum ${maxPicks} picks allowed`); return prev; }
        newPicks.set(key, { crewId, eventId: "", margin: 0 });
        return newPicks;
      }

      // One pick per race — swap out any existing pick from the same event.
      let oldMargin = 0;
      for (const [k, v] of newPicks) {
        if (v.eventId === eventId) { oldMargin = v.margin; newPicks.delete(k); break; }
      }
      if (!oldMargin && newPicks.size >= maxPicks) { toast.error(`Maximum ${maxPicks} picks allowed`); return prev; }
      newPicks.set(key, { crewId, eventId, margin: oldMargin });
      return newPicks;
    });

  };

  const updateCrewMargin = (crewId: string, eventId: string, margin: number) => {
    setCrewPicks((prev) => {
      const newPicks = new Map(prev);
      const key = pickKey(crewId, eventId);
      const existing = newPicks.get(key);
      if (!existing) return prev;
      newPicks.set(key, { ...existing, margin });
      return newPicks;
    });
  };


  const isContestOpen = contestPool?.status === "open" && new Date(contestPool.lock_time) > new Date();
  const numDivisions = divisions.length;
  // Podium Predictor: bounded by the number of distinct competitors in the sole race.
  const predictionCompetitorCount = isPrediction
    ? new Set((contestPool?.contest_pool_crews ?? []).map((c) => c.crew_id)).size
    : 0;
  // GC rosters are bounded by competitor count, not race count.
  const pickCeiling = isPerCompetitor
    ? competitorList.length
    : isPrediction
      ? predictionCompetitorCount
      : numDivisions;
  const minPicks = isPrediction
    ? (contestPool?.contest_templates?.min_picks ?? podiumSize)
    : Math.min(contestPool?.contest_templates?.min_picks ?? 2, pickCeiling);
  const maxPicks = isPrediction
    ? (contestPool?.contest_templates?.max_picks ?? podiumSize)
    : Math.min(contestPool?.contest_templates?.max_picks ?? 10, pickCeiling);



  const formattedLockTime = contestPool?.lock_time
    ? new Date(contestPool.lock_time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

  // ── Survivor derived state (all gated on isSurvivor) ──
  const fmtRoundTime = (iso: string) =>
    new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const entryRoundByNo = useMemo(() => {
    const m = new Map<number, SurvivorEntryRound>();
    for (const r of survivorEntryRounds) m.set(r.round_no, r);
    return m;
  }, [survivorEntryRounds]);

  /** Mirrors the backend rule: any scored round without an advanced===true entry-round row eliminates. */
  const eliminatedInRound = useMemo(() => {
    if (!isSurvivor || !survivorEntry) return null;
    for (const r of survivorRounds) {
      if (r.status !== "scored") continue;
      const er = entryRoundByNo.get(r.round_no);
      if (!er || er.advanced !== true) return r.round_no;
    }
    return null;
  }, [isSurvivor, survivorEntry, survivorRounds, entryRoundByNo]);

  const actionableRound = useMemo(() => {
    if (!isSurvivor || !survivorEntry || eliminatedInRound !== null) return null;
    const now = Date.now();
    const candidates = survivorRounds
      .filter((r) => r.status === "scheduled" && r.round_no >= 2 && new Date(r.lock_at).getTime() > now)
      .sort((a, b) => a.round_no - b.round_no);
    return candidates[0] ?? null;
  }, [isSurvivor, survivorEntry, eliminatedInRound, survivorRounds]);

  const actionableRaces = useMemo(() => {
    if (!actionableRound) return [] as SurvivorRace[];
    return survivorRaces
      .filter((r) => r.round_no === actionableRound.round_no)
      .sort((a, b) => a.race_order - b.race_order);
  }, [actionableRound, survivorRaces]);

  const survivorRoundMinPicks = contestPool?.contest_templates?.min_picks ?? 2;
  const roundMisconfigured = actionableRaces.length < survivorRoundMinPicks;

  const hasExistingRoundPicks = actionableRound ? entryRoundByNo.has(actionableRound.round_no) : false;

  // Pre-fill the pick form from an already-submitted round row.
  useEffect(() => {
    if (!isSurvivor || !actionableRound) { setRoundPicks(new Map()); return; }
    const existing = entryRoundByNo.get(actionableRound.round_no);
    const next = new Map<string, string>();
    const raw = existing?.picks;
    if (Array.isArray(raw)) {
      for (const p of raw as any[]) {
        const eventId = p?.event_id ?? p?.eventId;
        const crewId = p?.crewId ?? p?.crew_id;
        if (eventId && crewId) next.set(String(eventId), String(crewId));
      }
    }
    setRoundPicks(next);
  }, [isSurvivor, actionableRound?.round_no, entryRoundByNo]);

  const handleSubmitRoundPicks = async () => {
    if (roundSubmitRef.current || roundSubmitting || !survivorEntry || !actionableRound) return;
    roundSubmitRef.current = true;

    const picks = Array.from(roundPicks.entries()).map(([event_id, crewId]) => ({ crewId, event_id }));

    const raceMap = new Map(actionableRaces.map((r) => [r.race_key, r]));
    const pickValid = picks.every((p) => {
      const race = raceMap.get(p.event_id);
      if (!race) return false;
      return race.competitors.some((c) => c.crew_id === p.crewId);
    });
    if (!pickValid) {
      toast.error("One of your picks is no longer valid for this round — please reselect.");
      setRoundPicks(new Map());
      roundSubmitRef.current = false;
      return;
    }

    if (picks.length !== survivorRoundMinPicks) {
      toast.error(`Please select exactly ${survivorRoundMinPicks} picks for this round`);
      roundSubmitRef.current = false;
      return;
    }
    if (new Set(picks.map((p) => p.event_id)).size !== picks.length) {
      toast.error("You can only select one crew per race");
      roundSubmitRef.current = false;
      return;
    }
    if (new Set(picks.map((p) => p.event_id)).size < 2) {
      toast.error("You must pick from at least 2 different races");
      roundSubmitRef.current = false;
      return;
    }
    if (new Set(picks.map((p) => p.crewId)).size < 2) {
      toast.error("You must pick at least 2 different competitors");
      roundSubmitRef.current = false;
      return;
    }

    setRoundSubmitting(true);
    try {
      const { data, error } = await invokeGeoFunction("survivor-round-picks", {
        body: { entryId: survivorEntry.id, roundNo: actionableRound.round_no, picks },
      });
      if (error) {
        // Proxied path already carries the body's error string on error.message.
        let message = error.message || "Failed to submit picks";
        const ctx = (error as any).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const body = await ctx.json();
            message = body?.error || body?.message || message;
          } catch { /* keep message */ }
        }
        toast.error(message);
        return;
      }
      toast.success(data?.message || "Picks saved");
      setSurvivorRefreshKey((k) => k + 1);
    } catch (err: any) {
      let message = err?.message || "Failed to submit picks";
      const ctx = err?.context;
      if (ctx && typeof ctx.json === "function") {
        try {
          const body = await ctx.json();
          message = body?.error || body?.message || message;
        } catch { /* keep message */ }
      }
      toast.error(message);
    } finally {
      setRoundSubmitting(false);
      roundSubmitRef.current = false;
    }
  };



  const allMarginsValid = useMemo(() => {
    if (!needsMargin) return true;
    for (const [, pick] of crewPicks) {
      if (!(pick.margin > 0)) return false;
    }

    return true;
  }, [crewPicks, needsMargin]);

  const entryTiers = contestPool?.entry_tiers as EntryTier[] | null;
  const hasTiers = !!(entryTiers && entryTiers.length > 1);
  const activeEntryFee = hasTiers && selectedTier ? selectedTier.entry_fee_cents : contestPool?.entry_fee_cents ?? 0;

  const payoutRows = useMemo(() => {
    if (!contestPool?.payout_structure) return [];
    return Object.entries(contestPool.payout_structure)
      .map(([rank, cents]) => ({ rank: Number(rank), cents }))
      .sort((a, b) => a.rank - b.rank);
  }, [contestPool]);

  // Header stats — tiered-aware
  const headerStats = useMemo(() => {
    if (!contestPool) return { firstPrize: 0, entryFeeLabel: "", entriesLabel: "", isTiered: false };
    if (hasTiers && entryTiers) {
      const highestPrize = Math.max(...entryTiers.map(t => {
        const ps = t.payout_structure || {};
        return (ps as any)['1'] || 0;
      }));
      const lowestFee = Math.min(...entryTiers.map(t => t.entry_fee_cents));
      const perTierMax = allTemplatePools[0]?.max_entries || contestPool.max_entries;
      const hasOverflow = allTemplatePools.some((p: any) => p.allow_overflow);
      const contestType = perTierMax === 2 ? 'Head to Head' : `${perTierMax} Player Pool`;
      return {
        firstPrize: highestPrize,
        firstPrizePrefix: "Up to ",
        entryFeeLabel: `From ${formatCents(lowestFee)}`,
        entriesLabel: hasOverflow ? contestType : `${contestPool.current_entries}/${contestPool.max_entries}`,
        entriesSublabel: hasOverflow ? "Type" : "Entries",
        isTiered: true,
      };
    }
    const firstPrize = payoutRows.length > 0 ? payoutRows[0].cents : contestPool.prize_pool_cents ?? 0;
    return {
      firstPrize,
      firstPrizePrefix: "",
      entryFeeLabel: formatCents(contestPool.entry_fee_cents),
      entriesLabel: `${contestPool.current_entries}/${contestPool.max_entries}`,
      entriesSublabel: "Entries",
      isTiered: false,
    };
  }, [contestPool, hasTiers, entryTiers, payoutRows, allTemplatePools]);

  const totalPrize = payoutRows.length > 0
    ? payoutRows.reduce((sum, r) => sum + r.cents, 0)
    : contestPool?.prize_pool_cents ?? 0;
  const fillPercent = contestPool ? Math.min(100, (contestPool.current_entries / contestPool.max_entries) * 100) : 0;

  const draftPicksList = useMemo(() => {
    return Array.from(crewPicks.values()).map((p) => {
      const crew = isPerCompetitor
        ? contestPool?.contest_pool_crews.find((c) => c.crew_id === p.crewId)
        : contestPool?.contest_pool_crews.find((c) => c.crew_id === p.crewId && c.event_id === p.eventId);
      return { crewId: p.crewId, crewName: crew?.crew_name ?? p.crewId, eventId: p.eventId, margin: p.margin, logoUrl: crew?.logo_url };
    });
  }, [crewPicks, contestPool, isPerCompetitor]);



  const handleSubmitEntry = async () => {
    if (!user) {
      navigate("/login", { state: { from: `/regatta/${id}` } });
      return;
    }
    if (!id || !contestPool) return;
    if (isTierPick) {
      const covered = new Set<number>();
      for (const p of crewPicks.values()) {
        const ti = tierOfCompetitor.get(p.crewId);
        if (ti === undefined) { toast.error("Pick exactly one competitor from each tier."); return; }
        if (covered.has(ti)) { toast.error("Pick exactly one competitor from each tier."); return; }
        covered.add(ti);
      }
      if (covered.size !== rosterTiers!.length) { toast.error("Pick exactly one competitor from each tier."); return; }
    } else if (crewPicks.size < minPicks) { toast.error(`Please select at least ${minPicks} ${t.competitors}`); return; }

    if (needsMargin) {
      for (const [, p] of crewPicks) {
        if (!(p.margin > 0)) {
          const crew = contestPool.contest_pool_crews.find((c) => c.crew_id === p.crewId && c.event_id === p.eventId);
          toast.error(`Please enter a valid margin for ${crew?.crew_name || p.crewId}`);
          return;
        }
      }
    }
    if (isPrediction) {
      if (crewPicks.size !== podiumSize) { toast.error(`Pick exactly ${podiumSize} ${t.competitors} for the podium`); return; }
      const positions = Array.from(crewPicks.values()).map((p) => p.position);
      const expected = Array.from({ length: podiumSize }, (_, i) => i + 1);
      const sorted = positions.slice().sort((a, b) => Number(a) - Number(b));
      if (sorted.length !== expected.length || sorted.some((v, i) => v !== expected[i])) {
        toast.error("Podium positions must be filled in order.");
        return;
      }
    } else if (!isPerCompetitor) {
      const selectedDivisions = new Set<string>();
      for (const p of crewPicks.values()) selectedDivisions.add(p.eventId);
      if (selectedDivisions.size < 2) { toast.error(`You must select ${t.competitors} from at least 2 different ${t.events}`); return; }
    }


    if (hasTiers && !selectedTier) { toast.error("Please select an entry tier"); return; }
    // (Wave 1 #6) Fail-closed: refuse submit if balance read errored.
    if (wallet.status === 'error') {
      toast.error('Balance temporarily unavailable. Please retry before entering.');
      return;
    }
    if (walletBalanceCents !== null && walletBalanceCents < activeEntryFee) {
      toast.error(`Insufficient balance. You need ${formatCents(activeEntryFee)} but have ${formatCents(walletBalanceCents)}.`);
      return;
    }

    setSubmitting(true);
    const picks = Array.from(crewPicks.values()).map((p) => {
      // Podium Predictor: ordered picks carry a position, never a margin.
      if (isPrediction) return { crewId: p.crewId, event_id: p.eventId, position: p.position! };
      // GC rosters carry only the competitor — no event, no margin.
      if (isPerCompetitor) return { crewId: p.crewId };
      const base = { crewId: p.crewId, event_id: p.eventId };
      return needsMargin ? { ...base, predictedMargin: p.margin } : base;
    });




    try {
      const { data, error } = await invokeGeoFunction("contest-matchmaking", {
        body: {
          contestTemplateId: contestPool.contest_template_id,
          tierId: contestPool.id,
          picks,
          entryFeeCents: activeEntryFee,
          tierName: selectedTier?.name ?? null,
          stateCode: null,
        },
      });
      if (error) throw error;
      if (data?.entryId) {
        toast.success("Entry submitted! You're in the contest.");
      } else {
        toast.error(data?.error || "Failed to submit entry.");
        return;
      }
      // (Wave 1 #6) Refresh balance via centralized fail-closed RPC.
      await wallet.refetch();
      setTimeout(() => navigate("/my-entries"), 1500);
    } catch (err: any) {
      let errorMessage = "Failed to enter contest";
      if (err.context?.json) {
        try {
          const ctx = typeof err.context.json === "string" ? JSON.parse(err.context.json) : err.context.json;
          errorMessage = ctx.error || ctx.message || errorMessage;
        } catch { errorMessage = err.message || errorMessage; }
      } else if (err.message) { errorMessage = err.message; }
      toast.error(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 className="h-12 w-12 animate-spin text-accent" />
        </main>
      </div>
    );
  }

  if (error || !contestPool) {
    return (
      <div className="flex flex-col min-h-screen bg-background">
        <Header />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-2 text-white">Contest Not Found</h2>
            <p className="text-white/60 mb-4">{error}</p>
            <Link to="/lobby"><Button>Back to Lobby</Button></Link>
          </div>
        </main>
      </div>
    );
  }

  const statusLabel = isContestOpen ? "Open" : contestPool.status.charAt(0).toUpperCase() + contestPool.status.slice(1);

  return (
    <div className="flex flex-col min-h-screen relative">
      <DraftPageBackground />
      <div className="relative z-10 flex flex-col min-h-screen">
      <Header />
      {/* ── Banner Image Header ── */}
      <ContestBannerHeader
        regattaName={displayName}
        genderCategory={contestPool.contest_templates.gender_category}
        lockTime={contestPool.lock_time}
        status={contestPool.status}
        bannerUrl={contestPool.contest_templates.draft_banner_url || contestPool.contest_templates.card_banner_url}
        maxEntries={contestPool.max_entries}
        entryFeeCents={contestPool.entry_fee_cents}
        entryTiers={entryTiers}
        allowOverflow={contestPool.allow_overflow}
      />

      {/* ── Main Content ── */}
      <main className="flex-1 pb-32 lg:pb-12">
        <div className="container mx-auto px-4 max-w-6xl py-6 lg:py-8">
          {!isContestOpen && (
            <div className="mb-6 px-6 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-center">
              <p className="text-red-400 font-medium text-sm flex items-center justify-center gap-2">
                <Lock className="h-4 w-4 text-red-400" />
                This contest is no longer accepting entries.
              </p>
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            {/* ── LEFT: Crew Selection ── */}
            <div className="flex-1 min-w-0 space-y-5">
               <div>
                <h2 className="font-heading text-xl lg:text-2xl font-bold mb-1 text-white">Select Your {t.Competitors}</h2>
                <p className="text-sm text-white/60">
                  {isPerCompetitor
                    ? `Pick ${minPicks} ${t.competitors} — every stage counts toward your combined time.`
                    : `Draft a ${t.competitor} from each ${t.event}. Your entry will be matched against other players.`}
                </p>
                {isSurvivor && (
                  <p className="text-sm text-white/60 mt-1">
                    {`Round 1 of ${survivorRounds.length} — pick ${minPicks} from these races. Survive each round to advance.`}
                  </p>
                )}
              </div>

              {/* ── Survivor: Elimination rounds (entry-scoped, renders even when locked) ── */}
              {isSurvivor && survivorEntry && (
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4 space-y-4">
                    <h3 className="font-heading text-sm font-bold text-slate-900">Elimination rounds</h3>

                    <div className="space-y-2">
                      {survivorRounds.map((r) => {
                        const er = entryRoundByNo.get(r.round_no);
                        const statusChip =
                          r.status === "scored" ? "Complete" : r.status === "locked" ? "In progress" : "Upcoming";
                        return (
                          <div key={r.round_no} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-slate-900">Round {r.round_no}</p>
                              <p className="text-xs text-slate-500">
                                Locks {fmtRoundTime(r.lock_at)} · Advances: {r.advance_count}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 font-medium text-slate-700">{statusChip}</span>
                              {er && er.points !== null && (
                                <span className="font-medium text-slate-700">{er.points} pts</span>
                              )}
                              {er && er.advanced === true && (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">Advanced</span>
                              )}
                              {er && er.advanced === false && (
                                <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">Eliminated</span>
                              )}
                              {er && er.advanced === null && er.points === null && (
                                <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-700">Picks in</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {eliminatedInRound !== null ? (
                      <p className="text-sm font-semibold text-red-600">Eliminated in round {eliminatedInRound}</p>
                    ) : actionableRound ? (
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-bold text-slate-900">
                            Round {actionableRound.round_no} picks — choose {survivorRoundMinPicks}
                          </p>
                          <p className="text-xs text-slate-500">Locks {fmtRoundTime(actionableRound.lock_at)}</p>
                        </div>
                        {roundMisconfigured ? (
                          <p className="text-sm text-slate-600">
                            This round isn't ready for picks yet. Please check back shortly or contact support.
                          </p>
                        ) : (
                          <>
                            {actionableRaces.map((race) => (
                              <div key={race.race_key}>
                                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                                  {race.name || race.race_key}
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  {race.competitors.map((c) => {
                                    const selected = roundPicks.get(race.race_key) === c.crew_id;
                                    return (
                                      <button
                                        key={`${race.race_key}::${c.crew_id}`}
                                        type="button"
                                        onClick={() =>
                                          setRoundPicks((prev) => {
                                            const next = new Map(prev);
                                            if (next.get(race.race_key) === c.crew_id) next.delete(race.race_key);
                                            else next.set(race.race_key, c.crew_id);
                                            return next;
                                          })
                                        }
                                        className={`flex items-center gap-3 rounded-lg border-2 px-3 py-2 text-left transition-all ${
                                          selected ? "border-teal-400 bg-teal-50" : "border-slate-200 bg-white hover:bg-slate-50"
                                        }`}
                                      >
                                        <CrewLogo logoUrl={c.logo_url} crewName={c.crew_name} size={32} />
                                        <span className="text-sm font-semibold text-slate-900 truncate">{c.crew_name}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                            <Button
                              variant="hero"
                              className="w-full rounded-xl font-semibold"
                              disabled={roundSubmitting || roundPicks.size !== survivorRoundMinPicks || roundMisconfigured}
                              onClick={handleSubmitRoundPicks}
                            >
                              {roundSubmitting ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                              ) : hasExistingRoundPicks ? (
                                "Update picks"
                              ) : (
                                "Submit picks"
                              )}
                            </Button>
                          </>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-600">No round is open for picks right now.</p>
                    )}
                  </CardContent>
                </Card>
              )}


              {isPerCompetitor && stageList.length > 0 && (
                <div className="rounded-xl border border-white/15 bg-white/5 p-3">
                  <p className="text-xs font-semibold text-white/80 mb-2">Stages ({stageList.length})</p>
                  <div className="flex flex-wrap gap-2">
                    {stageList.map((s, i) => (
                      <span key={s.race_key} className="rounded-full bg-white/10 text-white/80 text-xs px-3 py-1 border border-white/15">
                        {i + 1}. {s.name || s.race_key}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {isTierPick ? (
                <div className="space-y-6">
                  {rosterTiers!.map((tier, tIdx) => {
                    const members = competitorList.filter((c) => tierOfCompetitor.get(c.crew_id) === tIdx);
                    if (members.length === 0) return null;
                    return (
                      <div key={`${tier.name}-${tIdx}`}>
                        <div className="flex items-center gap-2 mb-3">
                          <div className="flex items-center gap-2 rounded-full bg-white/10 text-white px-3 py-1 border border-white/15">
                            <span className="font-semibold text-xs">{tier.name || `Tier ${tIdx + 1}`}</span>
                            <span className="text-white/60 text-xs">· Pick 1</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {members.map((crew, idx) => (
                            <CrewCard
                              key={crew.crew_id}
                              crewId={crew.crew_id}
                              crewName={crew.crew_name}
                              eventId=""
                              logoUrl={crew.logo_url}
                              isSelected={crewPicks.has(crew.crew_id)}
                              marginVal={0}
                              isOpen={!!isContestOpen}
                              showMargin={false}
                              onToggle={toggleCrewSelection}
                              onMarginChange={updateCrewMargin}
                              animDelay={idx * 50}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : isPerCompetitor ? (

                competitorList.length === 0 ? (
                  <Card className="bg-card border-border"><CardContent className="py-8 text-center text-muted-foreground">No {t.competitors} available.</CardContent></Card>
                ) : (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="flex items-center gap-2 rounded-full bg-white/10 text-white px-3 py-1 border border-white/15">
                        <span className="font-semibold text-xs">{t.Competitors}</span>
                        <span className="text-white/60 text-xs">· {competitorList.length}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {competitorList.map((crew, idx) => (
                        <CrewCard
                          key={crew.crew_id}
                          crewId={crew.crew_id}
                          crewName={crew.crew_name}
                          eventId=""
                          logoUrl={crew.logo_url}
                          isSelected={crewPicks.has(crew.crew_id)}
                          marginVal={0}
                          isOpen={!!isContestOpen}
                          showMargin={false}
                          onToggle={toggleCrewSelection}
                          onMarginChange={updateCrewMargin}
                          animDelay={idx * 50}
                        />
                      ))}
                    </div>
                  </div>
                )
              ) : divisions.length === 0 ? (
                <Card className="bg-card border-border"><CardContent className="py-8 text-center text-muted-foreground">No {t.competitors} available.</CardContent></Card>
              ) : (

                divisions.map((divisionId) => (
                  <div key={divisionId}>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="flex items-center gap-2 rounded-full bg-white/10 text-white px-3 py-1 border border-white/15">
                        <span className="font-semibold text-xs">{divisionId}</span>
                        <span className="text-white/60 text-xs">· {crewsByDivision[divisionId].length} {t.competitors}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {crewsByDivision[divisionId].map((crew, idx) => {
                        const pos = crewPicks.get(pickKey(crew.crew_id, divisionId))?.position;
                        const weight = crewPicks.get(pickKey(crew.crew_id, divisionId))?.weight;
                        const card = (
                          <CrewCard
                            key={crew.id}
                            crewId={crew.crew_id}
                            crewName={crew.crew_name}
                            eventId={divisionId}
                            logoUrl={crew.logo_url}
                            isSelected={crewPicks.has(pickKey(crew.crew_id, divisionId))}
                            marginVal={crewPicks.get(pickKey(crew.crew_id, divisionId))?.margin ?? 0}

                            isOpen={!!isContestOpen}
                            showMargin={needsMargin}
                            onToggle={toggleCrewSelection}
                            onMarginChange={updateCrewMargin}
                            animDelay={idx * 50}
                          />
                        );
                        if (isConfidence) {
                          return (
                            <div key={crew.id} className="flex items-center gap-2">
                              <span
                                className={`flex-shrink-0 w-9 text-center rounded-md text-[11px] font-bold px-1.5 py-1 pointer-events-none ${
                                  weight ? "bg-accent text-accent-foreground shadow" : "bg-white/10 text-white/50"
                                }`}
                              >
                                {weight ? `#${weight}` : "—"}
                              </span>
                              <div className="flex-1 min-w-0">{card}</div>
                            </div>
                          );
                        }
                        if (!isPrediction) return card;
                        return (
                          <div key={crew.id} className="relative">
                            {card}
                            {pos ? (
                              <span className="absolute top-2 right-2 z-10 rounded-full bg-accent text-accent-foreground text-[11px] font-bold px-2 py-0.5 shadow">
                                {ordinal(pos)}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}

                    </div>
                  </div>
                ))
              )}
            </div>

            {/* ── RIGHT: Sticky Sidebar ── */}
            <div className="w-full lg:w-[340px] lg:sticky lg:top-4 lg:self-start space-y-4">
              {/* 1. Your Draft — always first */}
              <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20 border-t-2 border-t-accent">
                <CardContent className="p-4">
                  <h3 className="font-heading text-sm font-bold mb-3 flex items-center gap-2 text-slate-900"><Zap className="h-4 w-4 text-accent" />Your Draft</h3>

                  {/* Tier Selection */}
                  {hasTiers && (
                    <TierSelector
                      tiers={entryTiers!}
                      selectedTier={selectedTier}
                      onSelectTier={setSelectedTier}
                      walletBalanceCents={walletBalanceCents}
                    />
                  )}

                  <DraftPicksList
                    picks={draftPicksList}
                    events={divisions}
                    maxPicks={maxPicks}
                    onRemove={toggleCrewSelection}
                    competitorNoun={t.competitor}
                  />

                   <div className="mt-4">
                    {!user ? (
                      <Button
                        variant="hero"
                        className="w-full rounded-xl font-semibold"
                        onClick={() => navigate("/login", { state: { from: `/regatta/${id}` } })}
                      >
                        Log In to Enter
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="hero"
                          className="w-full rounded-xl font-semibold"
                          disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier) || submitting}
                          onClick={handleSubmitEntry}
                        >
                          {submitting ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</>
                          ) : hasTiers && !selectedTier ? (
                            "Select a Tier"
                          ) : (
                            `Enter Contest — ${formatCents(activeEntryFee)}`
                          )}
                        </Button>

                        {walletBalanceCents !== null && (
                          <div className={`flex items-center gap-1.5 mt-3 text-xs ${walletBalanceCents < activeEntryFee ? "text-destructive" : "text-muted-foreground"}`}>
                            <Wallet className="h-3.5 w-3.5" />
                            Balance: {formatCents(walletBalanceCents)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* 2. Prize Pool — Collapsible */}
              <Collapsible open={prizePoolOpen} onOpenChange={setPrizePoolOpen}>
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4">
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-gold" />Prize Pool
                      </h3>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${prizePoolOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="mt-3">
                        {hasTiers && entryTiers ? (
                          <div className="space-y-3">
                            {entryTiers.map((tier) => {
                              const tierPayoutRows = Object.entries(tier.payout_structure)
                                .map(([rank, cents]) => ({ rank: Number(rank), cents }))
                                .sort((a, b) => a.rank - b.rank);
                              const accentClass = TIER_ACCENT[tier.name] || "border-l-accent bg-accent/5";
                              return (
                                <div key={tier.name} className={`border-l-4 rounded-r-lg pl-3 py-2 ${accentClass}`}>
                                  <p className="text-xs font-semibold text-foreground mb-1">{tier.name} <span className="text-muted-foreground font-normal">({formatCents(tier.entry_fee_cents)} entry)</span></p>
                                  <div className="space-y-0.5">
                                    {tierPayoutRows.map((row) => {
                                      const medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : null;
                                      return (
                                        <div key={row.rank} className="flex justify-between items-center text-sm">
                                          <span className={`flex items-center gap-2 ${row.rank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}`}>
                                            {medal && <span className="text-base leading-none">{medal}</span>}
                                            <span>{ordinal(row.rank)}</span>
                                          </span>
                                          <span className={row.rank === 1 ? "font-bold text-gold" : "font-medium"}>{formatCents(row.cents)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : payoutRows.length > 0 ? (
                          <div className="space-y-1.5">
                            {payoutRows.map(({ rank, cents }) => {
                              const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
                              return (
                                <div key={rank} className="flex justify-between items-center text-sm">
                                  <span className={`flex items-center gap-2 ${rank === 1 ? "font-semibold text-gold" : "text-muted-foreground"}`}>
                                    {medal && <span className="text-base leading-none">{medal}</span>}
                                    <span>{ordinal(rank)}</span>
                                  </span>
                                  <span className={rank === 1 ? "font-bold text-gold" : "font-medium"}>{formatCents(cents)}</span>
                                </div>
                              );
                            })}
                            <div className="flex justify-between text-sm border-t pt-1.5 mt-1.5"><span className="font-medium">Total</span><span className="font-bold">{formatCents(totalPrize)}</span></div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No prize details available.</p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </CardContent>
                </Card>
              </Collapsible>

              {/* 3. Scoring (Collapsible) */}
              <Collapsible open={scoringOpen} onOpenChange={setScoringOpen}>
                <Card className="rounded-xl bg-white/95 backdrop-blur-sm shadow-xl border border-white/20">
                  <CardContent className="p-4">
                    <CollapsibleTrigger className="flex items-center justify-between w-full">
                      <h3 className="font-heading text-sm font-bold">How Scoring Works</h3>
                      <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${scoringOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-3">
                      {isTierPick && (
                        <p className="text-xs text-muted-foreground mb-3">Pick one competitor from each tier.</p>
                      )}
                      {isPrediction ? (

                        <p className="text-xs text-muted-foreground">
                          {`Predict the podium in exact order. Exact position = ${Number.isFinite(Number((scoringConfig as any)?.points_exact)) ? Number((scoringConfig as any).points_exact) : 5} pts, on the podium but wrong slot = ${Number.isFinite(Number((scoringConfig as any)?.points_podium)) ? Number((scoringConfig as any).points_podium) : 2} pts. Highest total wins.`}
                        </p>
                      ) : isTimeScored ? (

                        <p className="text-xs text-muted-foreground">
                          {scoringConfig?.time_ref === "winner"
                            ? "Your picks' times behind each race winner are added — lowest total wins."
                            : "Your picks' finishing times are added together across every race/stage — lowest combined time wins. A DNF/DNS/DSQ is charged the slowest finisher's time +10%."}
                        </p>
                      ) : scoringConfig?.direction === "low" ? (
                        <p className="text-xs text-muted-foreground">
                          Each pick scores its finish place (1st = 1, 2nd = 2, …). Finish places are added together and the lowest total wins. A DNF/DNS/DSQ scores the race's field size + 1.
                        </p>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            {scoringPointsRows.map(([place, pts]) => (
                              <div key={place} className="flex justify-between text-xs text-muted-foreground">
                                <span>{ordinal(Number(place))}</span><span className="font-medium text-foreground">{pts} pts</span>
                              </div>
                            ))}
                            <div className="flex justify-between text-xs text-muted-foreground"><span>{ordinal(scoringPointsRows.length + 1)}+</span><span className="font-medium text-foreground">{DEFAULT_POINTS} pts</span></div>
                          </div>
                          {scoringConfig?.tiebreak === "aggregate_time" && (
                            <p className="text-xs text-muted-foreground mt-3">Ties broken by lowest combined time.</p>
                          )}
                        </>
                      )}
                    </CollapsibleContent>

                  </CardContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile sticky footer */}
      {isContestOpen && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-card/95 backdrop-blur-sm p-4 shadow-lg">
          {hasTiers && (
            <div className="flex gap-2 mb-2 overflow-x-auto">
              {entryTiers!.map((tier) => {
                const isSelected = selectedTier?.name === tier.name;
                const displayFee = formatCents(tier.entry_fee_cents);
                const insufficientBalance = walletBalanceCents !== null && walletBalanceCents < tier.entry_fee_cents;
                return (
                  <button
                    key={tier.name}
                    disabled={insufficientBalance}
                    onClick={() => !insufficientBalance && setSelectedTier(tier)}
                    className={`flex-1 min-w-0 rounded-lg py-2 text-center transition-all border-2 font-bold ${
                      insufficientBalance ? "opacity-40 cursor-not-allowed border-border bg-secondary text-muted-foreground"
                      : isSelected ? "border-accent bg-accent text-accent-foreground"
                      : "border-border bg-secondary cursor-pointer text-foreground"
                    }`}
                  >
                    {displayFee}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">{crewPicks.size} pick{crewPicks.size !== 1 ? "s" : ""} selected</span>
            {user && walletBalanceCents !== null && (
              <span className={`text-xs ${walletBalanceCents < activeEntryFee ? "text-destructive" : "text-muted-foreground"}`}>
                Balance: {formatCents(walletBalanceCents)}
              </span>
            )}
          </div>
          {!user ? (
            <Button
              variant="hero"
              className="w-full rounded-xl font-semibold"
              onClick={() => navigate("/login", { state: { from: `/regatta/${id}` } })}
            >
              Log In to Enter
            </Button>
          ) : (
            <Button
              variant="hero"
              className="w-full rounded-xl font-semibold"
              disabled={!isContestOpen || crewPicks.size < minPicks || !allMarginsValid || (hasTiers && !selectedTier) || submitting}
              onClick={handleSubmitEntry}
            >
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Entering...</> : hasTiers && !selectedTier ? "Select a Tier" : `Enter Contest — ${formatCents(activeEntryFee)}`}
            </Button>
          )}
        </div>
      )}

      <Footer />
      </div>
    </div>
  );
};

export default RegattaDetail;
