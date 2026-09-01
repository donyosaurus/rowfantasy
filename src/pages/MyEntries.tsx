// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
import { useEffect, useRef, useState } from "react";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { getCircleFlagUrl } from "@/data/countryFlags";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { invokeGeoFunction } from "@/integrations/supabase/geoFunctions";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

import { MatchupDialog } from "@/components/MatchupDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Calendar, DollarSign, TrendingUp, Users, Eye, Plus, X } from "lucide-react";
import myEntriesBg from "@/assets/my-entries-bg.jpg";
import { CrewLogo } from "@/components/CrewLogo";
import { toast } from "sonner";
import { formatCents, formatDollars } from "@/lib/formatCurrency";
import { formatSecondsAsTime } from "@/lib/utils";

/**
 * Templates with a null scoring_config, or a margin_error tiebreak, keep today's copy.
 * aggregate_time renders a formatted total time; none hides the line.
 */
/** time_vs_ref templates score in ms — show a formatted time, never points. */
function timeDisplayOf(scoringConfig: unknown): "total_time" | "behind_winners" | null {
  if (!scoringConfig || typeof scoringConfig !== "object") return null;
  const cfg = scoringConfig as { primitive?: string; time_ref?: string };
  if (cfg.primitive !== "time_vs_ref") return null;
  return cfg.time_ref === "winner" ? "behind_winners" : "total_time";
}

function tiebreakLine(tb: "margin_error" | "aggregate_time", marginBonus: number) {
  if (tb === "aggregate_time") {
    return <span className="text-muted-foreground">Total time: {formatSecondsAsTime(marginBonus)}</span>;
  }
  return marginBonus > 0
    ? <span className="text-muted-foreground">Margin error: {marginBonus.toFixed(1)}s</span>
    : null;
}

function tiebreakOf(scoringConfig: unknown): "margin_error" | "aggregate_time" | "none" {
  if (!scoringConfig || typeof scoringConfig !== "object") return "margin_error";
  const tb = (scoringConfig as { tiebreak?: string }).tiebreak;
  if (tb === "aggregate_time" || tb === "none") return tb;
  return "margin_error";
}

interface PickNew {
  crewId: string;
  predictedMargin: number;
}

interface Entry {
  id: string;
  created_at: string;
  status: string;
  entry_fee_cents: number;
  pool_id: string;
  contest_template_id: string;
  picks: PickNew[] | string[] | unknown;
  payout_cents?: number;
  rank?: number;
  tier_name?: string | null;
  contest_templates: {
    regatta_name: string;
    lock_time: string;
    scoring_config?: unknown | null;
    min_picks: number | null;
    max_entries_per_user: number | null;
  };

  contest_pools: {
    status: string;
    prize_pool_cents: number;
    max_entries: number;
    current_entries: number;
    payout_structure: Record<string, number> | null;
    tier_id: string;
    entry_fee_cents: number;
    contest_template_id: string;
  };
  contest_scores?: Array<{
    rank: number;
    total_points: number;
    margin_bonus: number;
    is_winner: boolean;
    payout_cents: number;
  }>;
}

interface CrewInfo {
  crew_id: string;
  crew_name: string;
  contest_pool_id: string;
  event_id?: string;
  logo_url?: string | null;
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

function isSurvivorTemplate(scoringConfig: unknown): boolean {
  return (
    !!scoringConfig &&
    typeof scoringConfig === "object" &&
    (scoringConfig as { primitive?: string }).primitive === "survivor"
  );
}



const MyEntries = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [crewMap, setCrewMap] = useState<Map<string, CrewInfo>>(new Map());
  const [competitorMap, setCompetitorMap] = useState<Map<string, { name: string; logo_url: string | null }>>(new Map());
  const [roundsByTemplate, setRoundsByTemplate] = useState<Map<string, SurvivorRound[]>>(new Map());
  const [entryRoundsByEntry, setEntryRoundsByEntry] = useState<Map<string, SurvivorEntryRound[]>>(new Map());

  const [loading, setLoading] = useState(true);
  const [matchupPoolId, setMatchupPoolId] = useState<string | null>(null);
  const [matchupEntry, setMatchupEntry] = useState<Entry | null>(null);
  const [resubmitEntry, setResubmitEntry] = useState<Entry | null>(null);
  const [resubmitting, setResubmitting] = useState(false);
  // Wave 1 #6: balance via fail-closed centralized RPC.
  const wallet = useWalletBalance();
  const walletBalanceCents: number | null = wallet.status === 'ready' ? wallet.availableCents : null;
  const poolChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const [stats, setStats] = useState({
    totalEntries: 0,
    activeEntries: 0,
    totalWinnings: 0,
    winRate: 0
  });

  useEffect(() => {
    if (!user) {
      navigate("/login");
      return;
    }

    loadEntries();

    const userChannel = supabase
      .channel('my-entries-user-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'contest_entries',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          loadEntries();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(userChannel);
      if (poolChannelRef.current) {
        supabase.removeChannel(poolChannelRef.current);
        poolChannelRef.current = null;
      }
    };
  }, [user, navigate]);

  const loadEntries = async () => {
    if (!user) return;

    try {
      const { data, error } = await supabase.
      from('contest_entries').
      select(`
          id, created_at, status, entry_fee_cents, pool_id, contest_template_id, picks, payout_cents, rank, tier_name,
          contest_templates!inner (regatta_name, lock_time, scoring_config, roster_mode, min_picks, max_entries_per_user),
          contest_pools!inner (status, prize_pool_cents, max_entries, current_entries, payout_structure, tier_id, entry_fee_cents, contest_template_id),
          contest_scores (rank, total_points, margin_bonus, is_winner, payout_cents)
        `).
      eq('user_id', user.id).
      order('created_at', { ascending: false });

      if (error) {
        console.error('Error loading entries:', error);
        return;
      }

      const entriesData = (data || []) as unknown as Entry[];
      setEntries(entriesData);

      const poolIds = [...new Set(entriesData.map((e) => e.pool_id).filter(Boolean))];

      // (Re)subscribe to opponent activity in any pool the user is in
      const activePoolIds = [...new Set(
        entriesData
          .filter((e) => ['active', 'scored'].includes(e.status))
          .map((e) => e.pool_id)
          .filter(Boolean)
      )];

      if (poolChannelRef.current) {
        supabase.removeChannel(poolChannelRef.current);
        poolChannelRef.current = null;
      }

      if (activePoolIds.length > 0) {
        const filter = `pool_id=in.(${activePoolIds.join(',')})`;
        const poolFilter = `id=in.(${activePoolIds.join(',')})`;
        poolChannelRef.current = supabase
          .channel(`my-entries-pool-updates-${Date.now()}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'contest_entries', filter },
            () => loadEntries()
          )
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'contest_entries', filter },
            () => loadEntries()
          )
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'contest_pools', filter: poolFilter },
            () => loadEntries()
          )
          .subscribe();
      }

      if (poolIds.length > 0) {
        const { data: crewsData, error: crewsError } = await supabase.
        from('contest_pool_crews').
        select('crew_id, crew_name, contest_pool_id, event_id, logo_url').
        in('contest_pool_id', poolIds);

        if (!crewsError && crewsData) {
          const newCrewMap = new Map<string, CrewInfo>();
          crewsData.forEach((crew) => {
            newCrewMap.set(`${crew.contest_pool_id}-${crew.crew_id}`, crew);
          });
          setCrewMap(newCrewMap);
        }
      }

      // --- Competitor-name fallback for v2 (scoring_config non-null) templates ---
      const v2TemplateIds = [
        ...new Set(
          entriesData
            .filter((e) => !!e.contest_templates?.scoring_config)
            .map((e) => e.contest_template_id)
            .filter(Boolean)
        ),
      ];
      setCompetitorMap(new Map());
      if (v2TemplateIds.length > 0) {
        const { data: compData, error: compError } = await supabase
          .from('contest_competitors')
          .select('template_id, competitor_key, name, logo_url')
          .in('template_id', v2TemplateIds);
        if (compError) {
          console.error('Error loading competitors:', compError);
        } else if (compData) {
          const newCompMap = new Map<string, { name: string; logo_url: string | null }>();
          compData.forEach((c) => {
            newCompMap.set(`${c.template_id}-${c.competitor_key}`, { name: c.name, logo_url: c.logo_url ?? null });
          });
          setCompetitorMap(newCompMap);
        }
      }

      // --- Survivor round data ---
      const survivorEntries = entriesData.filter((e) => isSurvivorTemplate(e.contest_templates?.scoring_config));
      setRoundsByTemplate(new Map());
      setEntryRoundsByEntry(new Map());
      if (survivorEntries.length > 0) {
        const survivorTemplateIds = [...new Set(survivorEntries.map((e) => e.contest_template_id).filter(Boolean))];
        const survivorEntryIds = survivorEntries.map((e) => e.id);

        const { data: roundsData, error: roundsError } = await supabase
          .from('contest_rounds')
          .select('template_id, round_no, lock_at, advance_count, status')
          .in('template_id', survivorTemplateIds)
          .order('round_no');
        if (roundsError) {
          console.error('Error loading survivor rounds:', roundsError);
        } else if (roundsData) {
          const nextRounds = new Map<string, SurvivorRound[]>();
          roundsData.forEach((r) => {
            const arr = nextRounds.get(r.template_id) ?? [];
            arr.push({ round_no: r.round_no, lock_at: r.lock_at, advance_count: r.advance_count, status: r.status });
            nextRounds.set(r.template_id, arr);
          });
          nextRounds.forEach((arr) => arr.sort((a, b) => a.round_no - b.round_no));
          setRoundsByTemplate(nextRounds);
        }

        const { data: erData, error: erError } = await supabase
          .from('contest_entry_rounds')
          .select('entry_id, round_no, picks, points, round_rank, advanced')
          .in('entry_id', survivorEntryIds)
          .order('round_no');
        if (erError) {
          console.error('Error loading survivor entry rounds:', erError);
        } else if (erData) {
          const nextEntryRounds = new Map<string, SurvivorEntryRound[]>();
          erData.forEach((r) => {
            const arr = nextEntryRounds.get(r.entry_id) ?? [];
            arr.push({
              round_no: r.round_no,
              picks: r.picks,
              points: r.points === null ? null : Number(r.points),
              round_rank: r.round_rank,
              advanced: r.advanced,
            });
            nextEntryRounds.set(r.entry_id, arr);
          });
          nextEntryRounds.forEach((arr) => arr.sort((a, b) => a.round_no - b.round_no));
          setEntryRoundsByEntry(nextEntryRounds);
        }
      }



      const completed = entriesData.filter((e) => e.contest_pools?.status === 'settled');
      const wins = completed.filter((e) => e.contest_scores?.[0]?.is_winner);
      const totalWinnings = completed.reduce(
        (sum, e) => sum + (e.contest_scores?.[0]?.payout_cents || 0),
        0
      );

      setStats({
        totalEntries: entriesData.length,
        activeEntries: entriesData.filter((e) => e.status === 'active' && !['settled','voided'].includes(e.contest_pools?.status || '')).length,
        totalWinnings: totalWinnings / 100,
        winRate: completed.length > 0 ? wins.length / completed.length * 100 : 0
      });

      // (Wave 1 #6) Direct .from('wallets') read removed — useWalletBalance
      // hook handles the load through get_user_wallet_balances() RPC.
    } catch (error) {
      console.error('Error loading entries:', error);
    } finally {
      setLoading(false);
    }
  };

  /** Mirrors the enter RPC's max_entries_per_user rule (default 1). */
  const isAtEntryCap = (entry: Entry): boolean => {
    const cap = entry.contest_templates?.max_entries_per_user ?? 1;
    const count = entries.filter(
      (e) => e.contest_template_id === entry.contest_template_id && ['active', 'scored', 'settled'].includes(e.status)
    ).length;
    return count >= cap;
  };

  const openResubmit = (entry: Entry) => {
    if (isAtEntryCap(entry)) {
      toast.error("You've already entered this contest the maximum number of times.");
      return;
    }
    if (entry.contest_pools?.status !== 'open') {

      toast.error('This contest has locked and is no longer accepting entries.');
      return;
    }
    if (new Date(entry.contest_templates.lock_time) <= new Date()) {
      toast.error('This contest has locked and is no longer accepting entries.');
      return;
    }
    setResubmitEntry(entry);
  };

  const handleResubmit = async () => {
    if (!resubmitEntry || !user) return;
    const entry = resubmitEntry;
    if (isAtEntryCap(entry)) {
      toast.error("You've already entered this contest the maximum number of times.");
      return;
    }
    const fee = entry.contest_pools?.entry_fee_cents ?? entry.entry_fee_cents;


    if (entry.contest_pools?.status !== 'open' || new Date(entry.contest_templates.lock_time) <= new Date()) {
      toast.error('This contest has locked and is no longer accepting entries.');
      setResubmitEntry(null);
      return;
    }
    // (Wave 1 #6) Fail-closed: refuse resubmit if balance read errored.
    if (wallet.status === 'error') {
      toast.error('Balance temporarily unavailable. Please retry before resubmitting.');
      return;
    }
    if (walletBalanceCents !== null && walletBalanceCents < fee) {
      toast.error(`Insufficient balance. You need ${formatCents(fee)} but have ${formatCents(walletBalanceCents)}.`);
      return;
    }

    // Normalize picks into the shape contest-matchmaking expects
    let rawPicks: unknown = entry.picks;
    if (typeof rawPicks === 'string') {
      try { rawPicks = JSON.parse(rawPicks); } catch { rawPicks = []; }
    }
    let picksArray: any[] = [];
    if (Array.isArray(rawPicks)) picksArray = rawPicks;
    else if (rawPicks && typeof rawPicks === 'object' && Array.isArray((rawPicks as any).crews)) {
      picksArray = (rawPicks as any).crews;
    }
    // GC (per_competitor) rosters carry only the competitor — never fabricate an event.
    const isPerCompetitor =
      !!entry.contest_templates?.scoring_config &&
      (entry.contest_templates as any)?.roster_mode === 'per_competitor';

    const picks = isPerCompetitor
      ? picksArray.map((p: any) => ({
          crewId: String(typeof p === 'string' ? p : (p.crewId || p.crew_id || p.id || '')),
        }))
      : picksArray.map((p: any) => {
          if (typeof p === 'string') return { crewId: p, event_id: '', predictedMargin: 0 };
          return {
            crewId: String(p.crewId || p.crew_id || p.id || ''),
            event_id: p.event_id || p.eventId || '',
            predictedMargin: Number(p.predictedMargin ?? p.predicted_margin ?? 0),
          };
        });

    // Backfill missing event_ids from crewMap (per_race / legacy only)
    if (!isPerCompetitor) {
      for (const pick of picks as any[]) {
        if (!pick.event_id) {
          const info = crewMap.get(`${entry.pool_id}-${pick.crewId}`) as any;
          if (info?.event_id) pick.event_id = info.event_id;
        }
      }
    }

    setResubmitting(true);
    try {
      const templateId = entry.contest_pools?.contest_template_id || entry.contest_template_id;
      const { data, error } = await invokeGeoFunction('contest-matchmaking', {
        body: {
          contestTemplateId: templateId,
          tierId: entry.pool_id,
          picks,
          entryFeeCents: fee,
          tierName: entry.tier_name ?? null,
          stateCode: null,
        },
      });
      if (error) throw error;
      if (data?.entryId) {
        toast.success("Entry submitted! You're in the contest.");
        setResubmitEntry(null);
        await loadEntries();
      } else {
        toast.error(data?.error || 'Failed to submit entry.');
      }
    } catch (err: any) {
      let errorMessage = 'Failed to submit entry';
      if (err?.context?.json) {
        try {
          const ctx = typeof err.context.json === 'string' ? JSON.parse(err.context.json) : err.context.json;
          errorMessage = ctx.error || ctx.message || errorMessage;
        } catch { errorMessage = err.message || errorMessage; }
      } else if (err?.message) errorMessage = err.message;
      toast.error(errorMessage);
    } finally {
      setResubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { label: string; className: string }> = {
      open: { label: 'Open', className: 'bg-success/10 text-success border-success/30' },
      locked: { label: 'Live', className: 'bg-gold/10 text-gold border-gold/30' },
      results_entered: { label: 'Results In', className: 'bg-gold/10 text-gold border-gold/30' },
      scoring_completed: { label: 'Scored', className: 'bg-accent/10 text-accent border-accent/30' },
      settling: { label: 'Settling', className: 'bg-accent/10 text-accent border-accent/30' },
      settled: { label: 'Completed', className: 'bg-muted text-muted-foreground' },
      voided: { label: 'Voided', className: 'bg-destructive/10 text-destructive border-destructive/30' },
      cancelled: { label: 'Cancelled', className: 'bg-destructive/10 text-destructive border-destructive/30' }
    };
    const config = statusMap[status] || { label: '—', className: 'bg-muted text-muted-foreground' };
    return <Badge variant="outline" className={config.className}>{config.label}</Badge>;
  };

  const getParsedPicks = (entry: Entry): {crewName: string;margin: number | null;logoUrl?: string | null;}[] => {
    let picks: unknown = entry.picks;
    if (!picks) return [];

    if (typeof picks === 'string') {
      try { picks = JSON.parse(picks); } catch { return []; }
    }

    let picksArray: unknown[];
    if (typeof picks === 'object' && picks !== null && !Array.isArray(picks) && 'crews' in (picks as Record<string, unknown>)) {
      const picksObj = picks as {crews: unknown[];};
      picksArray = Array.isArray(picksObj.crews) ? picksObj.crews : [];
    } else if (Array.isArray(picks)) {
      picksArray = picks;
    } else {
      return [];
    }

    const resolveCrew = (crewId: string) =>
      (crewMap.get(`${entry.pool_id}-${crewId}`) as { crew_name?: string; name?: string; logo_url?: string | null } | undefined) ??
      (competitorMap.get(`${entry.contest_template_id}-${crewId}`) as { crew_name?: string; name?: string; logo_url?: string | null } | undefined);

    return picksArray.map((pick) => {
      if (typeof pick === 'object' && pick !== null && 'crewId' in pick) {
        const pickObj = pick as PickNew;
        const resolved = resolveCrew(pickObj.crewId);
        const name = resolved?.crew_name ?? resolved?.name ?? pickObj.crewId;
        return { crewName: name, margin: pickObj.predictedMargin, logoUrl: getCircleFlagUrl(name) || resolved?.logo_url };
      }
      if (typeof pick === 'string') {
        const resolved = resolveCrew(pick);
        const name = resolved?.crew_name ?? resolved?.name ?? pick;
        return { crewName: name, margin: null, logoUrl: getCircleFlagUrl(name) || resolved?.logo_url };
      }
      return { crewName: 'Unknown', margin: null, logoUrl: null };
    });

  };

  const activeEntries = entries.filter(
    (e) => e.status === 'active' && !['settled', 'completed', 'voided'].includes(e.contest_pools?.status || '')
  );
  const completedEntries = entries.filter(
    (e) => ['settled', 'completed', 'voided'].includes(e.contest_pools?.status || '') || ['settled', 'voided'].includes(e.status)
  );

  if (loading) {
    return (
      <div className="flex flex-col min-h-screen">
        <Header />
        <main className="flex-1 py-8 bg-background">
          <div className="container mx-auto px-4 space-y-6">
            <Skeleton className="h-10 w-48" />
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </main>
        
      </div>
    );
  }

  const getStatusBorderColor = (entry: Entry) => {
    const poolStatus = entry.contest_pools?.status || '';
    const score = entry.contest_scores?.[0];
    if (['settled', 'completed'].includes(poolStatus) && score?.is_winner) return 'border-l-success';
    if (['settled', 'completed'].includes(poolStatus)) return 'border-l-muted-foreground';
    if (poolStatus === 'locked') return 'border-l-gold';
    return 'border-l-accent';
  };

  const renderEntryCard = (entry: Entry, showScore = false) => {
    const score = entry.contest_scores?.[0];
    const parsedPicks = getParsedPicks(entry);
    const payoutStructure = entry.contest_pools?.payout_structure;
    const poolStatus = entry.contest_pools?.status || '';
    const isSettled = ['settled', 'completed', 'voided'].includes(poolStatus) || ['settled', 'voided'].includes(entry.status);

    // ---- Survivor derivation (only active when the template's rounds loaded) ----
    const isSurvivor = isSurvivorTemplate(entry.contest_templates?.scoring_config);
    const rounds = roundsByTemplate.get(entry.contest_template_id);
    const survivorReady = isSurvivor && Array.isArray(rounds) && rounds.length > 0;
    const entryRounds: SurvivorEntryRound[] = survivorReady ? (entryRoundsByEntry.get(entry.id) ?? []) : [];
    const erByRound = new Map(entryRounds.map((r) => [r.round_no, r]));

    let eliminatedInRound: number | null = null;
    let actionableRound: SurvivorRound | null = null;
    let currentRoundNo = 0;
    if (survivorReady && rounds) {
      for (const r of rounds) {
        if (r.status === 'scored') {
          const er = erByRound.get(r.round_no);
          if (!er || er.advanced !== true) { eliminatedInRound = r.round_no; break; }
        }
      }
      const now = new Date();
      if (eliminatedInRound === null) {
        actionableRound =
          rounds.find((r) => r.status === 'scheduled' && new Date(r.lock_at) > now && r.round_no >= 2) ?? null;
      }
      const firstUnscored = rounds.find((r) => r.status !== 'scored');
      currentRoundNo = firstUnscored ? firstUnscored.round_no : rounds.length;
    }

    const roundStatusLabel = (s: string) =>
      s === 'scheduled' ? 'Upcoming' : s === 'locked' ? 'In progress' : s === 'scored' ? 'Complete' : s;

    const renderRoundsLadder = () => {
      if (!survivorReady || !rounds) return null;
      return (
        <div className="mt-4 pt-3 border-t space-y-1.5">
          {rounds.map((r) => {
            const er = erByRound.get(r.round_no);
            const parts: string[] = [];
            if (er) {
              if (er.points !== null) parts.push(`${er.points} pts`);
              if (er.advanced === true) parts.push('Advanced');
              else if (er.advanced === false) parts.push('Eliminated');
              else if (er.points === null) parts.push('Picks in');
            } else if (r.status === 'scored') {
              parts.push('No picks');
            }
            return (
              <div key={`${entry.id}-${r.round_no}`} className="flex items-center gap-2 text-sm">
                <span className="font-medium">Round {r.round_no}</span>
                <Badge variant="outline" className="text-xs">{roundStatusLabel(r.status)}</Badge>
                {parts.length > 0 && <span className="text-muted-foreground">{parts.join(' · ')}</span>}
              </div>
            );
          })}
        </div>
      );
    };


    const getTopPrize = (): number | null => {
      if (!payoutStructure) return null;
      return payoutStructure['1'] || null;
    };

    const topPrizeCents = getTopPrize();
    const prizePoolCents = entry.contest_pools?.prize_pool_cents || 0;

    const getPrizeDisplayText = (): string => {
      if (isSettled) return '';
      return topPrizeCents ? `Top Prize: ${formatCents(topPrizeCents)}` : `Prize Pool: ${formatCents(prizePoolCents)}`;
    };

    const getResultDisplay = () => {
      if (!isSettled) return null;
      if (entry.status === 'voided' || poolStatus === 'voided') return <Badge variant="secondary">Refunded</Badge>;
      const payoutCents = score?.payout_cents || 0;
      const rank = score?.rank || entry.rank;
      if (payoutCents > 0) return <Badge className="bg-success text-success-foreground">Won {formatCents(payoutCents)}</Badge>;
      if (rank) return <Badge variant="outline" className="text-muted-foreground">Finished #{rank}</Badge>;
      return <Badge variant="outline" className="text-muted-foreground">Did Not Win</Badge>;
    };

    const prizeText = getPrizeDisplayText();
    const resultDisplay = getResultDisplay();

    return (
      <Card key={entry.id} className={`rounded-xl card-hover overflow-hidden border-l-4 ${getStatusBorderColor(entry)}`}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <CardTitle className="text-lg font-heading">{entry.contest_templates.regatta_name}</CardTitle>
              <CardDescription className="space-y-1 mt-1">
                <div>
                  {entry.tier_name && <span className="text-accent font-medium">{entry.tier_name} Tier · </span>}
                  Entry: {formatCents(entry.entry_fee_cents)}
                  {prizeText && <span className="text-gold font-medium"> • {prizeText}</span>}
                </div>
                {!showScore && !survivorReady && <div>Locks: {new Date(entry.contest_templates.lock_time).toLocaleString()}</div>}
                {!showScore && survivorReady && eliminatedInRound === null && (
                  actionableRound
                    ? <div>Round {actionableRound.round_no} picks lock: {new Date(actionableRound.lock_at).toLocaleString()}</div>
                    : <div>Round {currentRoundNo} in progress</div>
                )}
                {showScore && <div>Entered: {new Date(entry.created_at).toLocaleDateString()}</div>}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {showScore && resultDisplay}
              {!showScore && survivorReady && (
                eliminatedInRound !== null
                  ? <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">Eliminated · Round {eliminatedInRound}</Badge>
                  : <Badge variant="outline" className="bg-gold/10 text-gold border-gold/30">Alive · Round {currentRoundNo} of {rounds!.length}</Badge>
              )}
              {!showScore && !survivorReady && getStatusBadge(entry.contest_pools?.status || 'open')}
            </div>

          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>{survivorReady ? `Round 1 picks (${parsedPicks.length})` : `Your Picks (${parsedPicks.length})`}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {parsedPicks.map((pick, idx) =>
                <Badge key={idx} variant="secondary" className="text-sm rounded-lg bg-primary/5 border border-primary/10 flex items-center gap-1.5">
                  <CrewLogo logoUrl={pick.logoUrl} crewName={pick.crewName} size={20} />
                  {pick.crewName}
                  {pick.margin !== null &&
                    <span className="ml-1 text-accent font-semibold">(+{pick.margin.toFixed(1)}s)</span>
                  }
                </Badge>
              )}
              {parsedPicks.length === 0 && <span className="text-sm text-muted-foreground">No picks recorded</span>}
            </div>
          </div>

          {renderRoundsLadder()}

          {/* Action buttons row */}

          <div className="flex justify-between items-center mt-3 gap-2">
            {entry.contest_pools?.status === 'open' && !isAtEntryCap(entry) && !isSurvivor ? (
              <Button
                type="button"
                size="sm"
                onClick={() => openResubmit(entry)}
                className="bg-accent text-accent-foreground hover:bg-accent/90 shadow-accent transition-smooth font-semibold"
              >
                <Plus className="h-4 w-4" />
                Submit Another Entry
              </Button>
            ) : survivorReady && !showScore && eliminatedInRound === null && actionableRound ? (
              <Button
                type="button"
                size="sm"
                onClick={() => navigate(`/regatta/${entry.pool_id}`)}
                className="bg-accent text-accent-foreground hover:bg-accent/90 shadow-accent transition-smooth font-semibold"
              >
                <Plus className="h-4 w-4" />
                {erByRound.has(actionableRound.round_no)
                  ? `Update Round ${actionableRound.round_no} picks`
                  : `Play Round ${actionableRound.round_no}`}
              </Button>
            ) : <span />}
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg text-xs gap-1.5"
              onClick={() => { setMatchupPoolId(entry.pool_id); setMatchupEntry(entry); }}
            >
              <Eye className="h-3.5 w-3.5" />
              View Matchup
            </Button>
          </div>





          {showScore && score && (
            <div className="flex flex-wrap items-center gap-4 text-sm pt-3 border-t text-muted-foreground">
              <span className="font-heading font-bold text-foreground">Rank: #{score.rank}</span>
              {(() => {
                const td = timeDisplayOf(entry.contest_templates?.scoring_config);
                if (td) {
                  return (
                    <span className="text-muted-foreground">
                      {td === "behind_winners" ? "Behind winners" : "Total time"}: {formatSecondsAsTime(score.margin_bonus)}
                    </span>
                  );
                }
                const tb = tiebreakOf(entry.contest_templates?.scoring_config);
                return (
                  <>
                    <span>{score.total_points} pts</span>
                    {tb !== "none" && tiebreakLine(tb, score.margin_bonus)}
                  </>
                );
              })()}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Fixed background image + gradient */}
      <div className="fixed inset-0 bg-cover bg-center bg-no-repeat z-0" style={{ backgroundImage: `url(${myEntriesBg})` }} />
      <div className="fixed inset-0 bg-gradient-to-b from-black/70 via-black/50 to-background z-0" />

      <Header />

      <main className="flex-1 relative z-10">
        <div className="container mx-auto px-4 py-10">
          <h1 className="text-4xl font-heading font-extrabold text-white mb-8">My Entries</h1>

          {/* Stats cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { icon: Trophy, label: "Total Entries", value: stats.totalEntries },
              { icon: Calendar, label: "Active", value: stats.activeEntries },
              { icon: DollarSign, label: "Winnings", value: formatDollars(stats.totalWinnings) },
              { icon: TrendingUp, label: "Win Rate", value: `${stats.winRate.toFixed(1)}%` },
            ].map((stat, i) => (
              <Card key={i} className="glass rounded-xl border-white/20 shadow-lg animate-fade-in" style={{ animationDelay: `${i * 0.1}s` }}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
                  <stat.icon className="h-4 w-4 text-accent" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-heading font-bold">{stat.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Entries List */}
          <Tabs defaultValue="active" className="space-y-4">
            <TabsList className="rounded-xl bg-white/10 backdrop-blur-sm p-1 h-auto border border-white/20">
              <TabsTrigger value="active" className="rounded-lg py-2.5 px-6 font-semibold data-[state=active]:bg-card data-[state=active]:shadow-sm">
                Active ({activeEntries.length})
              </TabsTrigger>
              <TabsTrigger value="completed" className="rounded-lg py-2.5 px-6 font-semibold data-[state=active]:bg-card data-[state=active]:shadow-sm">
                Completed ({completedEntries.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="active" className="space-y-4">
              {activeEntries.length === 0 ? (
                <Card className="rounded-xl shadow-md">
                  <CardContent className="py-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
                      <Trophy className="h-8 w-8 text-accent" />
                    </div>
                    <p className="text-muted-foreground mb-4">You don't have any active entries</p>
                    <Button onClick={() => navigate('/lobby')} variant="hero" className="rounded-xl">
                      Browse Contests
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                activeEntries.map((entry) => renderEntryCard(entry, false))
              )}
            </TabsContent>

            <TabsContent value="completed" className="space-y-4">
              {completedEntries.length === 0 ? (
                <Card className="rounded-xl shadow-md">
                  <CardContent className="py-12 text-center">
                    <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                      <Calendar className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <p className="text-muted-foreground">No completed entries yet</p>
                  </CardContent>
                </Card>
              ) : (
                completedEntries.map((entry) => renderEntryCard(entry, true))
              )}
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <Footer />

      {/* Matchup Dialog */}
      {matchupEntry && user && (
        <MatchupDialog
          open={!!matchupPoolId}
          onOpenChange={(open) => { if (!open) { setMatchupPoolId(null); setMatchupEntry(null); } }}
          poolId={matchupPoolId!}
          currentUserId={user.id}
          contestName={matchupEntry.contest_templates.regatta_name}
          poolStatus={matchupEntry.contest_pools?.status || matchupEntry.status || "unknown"}
          lockTime={matchupEntry.contest_templates.lock_time}
          maxEntries={matchupEntry.contest_pools?.max_entries || 0}
          currentEntries={matchupEntry.contest_pools?.current_entries || 0}
          payoutStructure={matchupEntry.contest_pools?.payout_structure || null}
          scoringConfig={matchupEntry.contest_templates?.scoring_config ?? null}
        />
      )}

      {/* Resubmit Entry Modal */}
      {resubmitEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
          onClick={() => !resubmitting && setResubmitEntry(null)}
        >
          <div
            className="bg-card w-full max-w-[380px] p-6 shadow-xl relative"
            style={{ borderRadius: 16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => !resubmitting && setResubmitEntry(null)}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            <h3 className="text-lg font-heading font-bold text-foreground pr-6">
              {resubmitEntry.contest_templates.regatta_name}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              New entry · {formatCents(resubmitEntry.contest_pools?.entry_fee_cents ?? resubmitEntry.entry_fee_cents)}
            </p>

            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Your Picks</p>
              <div className="flex flex-wrap gap-2">
                {getParsedPicks(resubmitEntry).map((pick, idx) => (
                  <Badge
                    key={idx}
                    variant="secondary"
                    className="text-sm rounded-lg bg-primary/5 border border-primary/10 flex items-center gap-1.5"
                  >
                    <CrewLogo logoUrl={pick.logoUrl} crewName={pick.crewName} size={20} />
                    {pick.crewName}
                    {pick.margin !== null && (
                      <span className="ml-1 text-accent font-semibold">(+{pick.margin.toFixed(1)}s)</span>
                    )}
                  </Badge>
                ))}
              </div>
            </div>

            <Button
              onClick={handleResubmit}
              disabled={resubmitting}
              className="w-full mt-5 bg-primary text-primary-foreground hover:bg-primary/90 font-semibold h-12"
              style={{ borderRadius: 12 }}
            >
              {resubmitting
                ? "Submitting..."
                : `Resubmit same picks — ${formatCents(resubmitEntry.contest_pools?.entry_fee_cents ?? resubmitEntry.entry_fee_cents)}`}
            </Button>

            <Button
              variant="outline"
              disabled={resubmitting}
              onClick={() => {
                const id = resubmitEntry.pool_id;
                setResubmitEntry(null);
                navigate(`/regatta/${id}`);
              }}
              className="w-full mt-2 h-12"
              style={{ borderRadius: 12 }}
            >
              Change my picks
            </Button>

            <p className="text-xs text-muted-foreground text-center mt-4">
              Locks {new Date(resubmitEntry.contest_templates.lock_time).toLocaleString([], {
                month: "numeric",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
              {walletBalanceCents !== null && ` · Wallet balance: ${formatCents(walletBalanceCents)}`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default MyEntries;
