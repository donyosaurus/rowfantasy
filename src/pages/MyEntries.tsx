import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";

import { MatchupDialog } from "@/components/MatchupDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Calendar, DollarSign, TrendingUp, Users, Eye } from "lucide-react";
import myEntriesBg from "@/assets/my-entries-bg.jpg";
import { CrewLogo } from "@/components/CrewLogo";

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
  picks: PickNew[] | string[] | unknown;
  payout_cents?: number;
  rank?: number;
  contest_templates: {
    regatta_name: string;
    lock_time: string;
  };
  contest_pools: {
    status: string;
    prize_pool_cents: number;
    max_entries: number;
    current_entries: number;
    payout_structure: Record<string, number> | null;
    tier_id: string;
    entry_fee_cents: number;
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
  logo_url?: string | null;
}

const MyEntries = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [crewMap, setCrewMap] = useState<Map<string, CrewInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [matchupPoolId, setMatchupPoolId] = useState<string | null>(null);
  const [matchupEntry, setMatchupEntry] = useState<Entry | null>(null);
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

    const channel = supabase.
    channel('my-entries-updates').
    on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'contest_entries',
        filter: `user_id=eq.${user.id}`
      },
      () => {
        loadEntries();
      }
    ).
    subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, navigate]);

  const loadEntries = async () => {
    if (!user) return;

    try {
      const { data, error } = await supabase.
      from('contest_entries').
      select(`
          id, created_at, status, entry_fee_cents, pool_id, picks, payout_cents, rank,
          contest_templates!inner (regatta_name, lock_time),
          contest_pools!inner (status, prize_pool_cents, max_entries, current_entries, payout_structure, tier_id, entry_fee_cents),
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

      if (poolIds.length > 0) {
        const { data: crewsData, error: crewsError } = await supabase.
        from('contest_pool_crews').
        select('crew_id, crew_name, contest_pool_id, logo_url').
        in('contest_pool_id', poolIds);

        if (!crewsError && crewsData) {
          const newCrewMap = new Map<string, CrewInfo>();
          crewsData.forEach((crew) => {
            newCrewMap.set(`${crew.contest_pool_id}-${crew.crew_id}`, crew);
          });
          setCrewMap(newCrewMap);
        }
      }

      const completed = entriesData.filter((e) => e.contest_pools?.status === 'completed');
      const wins = completed.filter((e) => e.contest_scores?.[0]?.is_winner);
      const totalWinnings = completed.reduce(
        (sum, e) => sum + (e.contest_scores?.[0]?.payout_cents || 0),
        0
      );

      setStats({
        totalEntries: entriesData.length,
        activeEntries: entriesData.filter((e) => e.status === 'active' && e.contest_pools?.status !== 'completed').length,
        totalWinnings: totalWinnings / 100,
        winRate: completed.length > 0 ? wins.length / completed.length * 100 : 0
      });
    } catch (error) {
      console.error('Error loading entries:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { label: string; className: string }> = {
      open: { label: 'Open', className: 'bg-success/10 text-success border-success/30' },
      locked: { label: 'Live', className: 'bg-gold/10 text-gold border-gold/30' },
      completed: { label: 'Completed', className: 'bg-muted text-muted-foreground' },
      cancelled: { label: 'Cancelled', className: 'bg-destructive/10 text-destructive border-destructive/30' }
    };
    const config = statusMap[status] || statusMap.open;
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

    return picksArray.map((pick) => {
      if (typeof pick === 'object' && pick !== null && 'crewId' in pick) {
        const pickObj = pick as PickNew;
        const crewInfo = crewMap.get(`${entry.pool_id}-${pickObj.crewId}`);
        return { crewName: crewInfo?.crew_name || pickObj.crewId, margin: pickObj.predictedMargin, logoUrl: crewInfo?.logo_url };
      }
      if (typeof pick === 'string') {
        const crewInfo = crewMap.get(`${entry.pool_id}-${pick}`);
        return { crewName: crewInfo?.crew_name || pick, margin: null, logoUrl: crewInfo?.logo_url };
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

    const getTopPrize = (): number | null => {
      if (!payoutStructure) return null;
      return payoutStructure['1'] || null;
    };

    const topPrizeCents = getTopPrize();
    const prizePoolCents = entry.contest_pools?.prize_pool_cents || 0;

    const getPrizeDisplayText = (): string => {
      if (isSettled) return '';
      return topPrizeCents ? `Top Prize: $${(topPrizeCents / 100).toFixed(2)}` : `Prize Pool: $${(prizePoolCents / 100).toFixed(2)}`;
    };

    const getResultDisplay = () => {
      if (!isSettled) return null;
      if (entry.status === 'voided' || poolStatus === 'voided') return <Badge variant="secondary">Refunded</Badge>;
      const payoutCents = score?.payout_cents || 0;
      const rank = score?.rank || entry.rank;
      if (payoutCents > 0) return <Badge className="bg-success text-success-foreground">Won ${(payoutCents / 100).toFixed(2)}</Badge>;
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
                  Entry: ${(entry.entry_fee_cents / 100).toFixed(2)}
                  {prizeText && <span className="text-gold font-medium"> • {prizeText}</span>}
                </div>
                {!showScore && <div>Locks: {new Date(entry.contest_templates.lock_time).toLocaleString()}</div>}
                {showScore && <div>Entered: {new Date(entry.created_at).toLocaleDateString()}</div>}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {showScore && resultDisplay}
              {!showScore && getStatusBadge(entry.contest_pools?.status || 'open')}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>Your Picks ({parsedPicks.length})</span>
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

          {/* View Matchup button */}
          <div className="flex justify-end mt-3">
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
              <span>{score.total_points} pts</span>
              {score.margin_bonus > 0 && <span className="text-accent">+{score.margin_bonus} margin bonus</span>}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Fixed background image + gradient — never stretches */}
      <div className="fixed inset-0 bg-cover bg-center bg-no-repeat z-0" style={{ backgroundImage: `url(${myEntriesBg})` }} />
      <div className="fixed inset-0 bg-gradient-to-b from-black/70 via-black/50 to-background z-0" />

      <div className="relative z-10 flex flex-col h-screen">
        <Header />

        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="container mx-auto px-4 flex flex-col flex-1 overflow-hidden pt-10">
            {/* Static: Title */}
            <h1 className="text-4xl font-heading font-extrabold text-white mb-8 shrink-0">My Entries</h1>

            {/* Static: Stats cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 shrink-0">
              {[
                { icon: Trophy, label: "Total Entries", value: stats.totalEntries },
                { icon: Calendar, label: "Active", value: stats.activeEntries },
                { icon: DollarSign, label: "Winnings", value: `$${stats.totalWinnings.toFixed(2)}` },
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

            {/* Tabs wrapper — tabs pinned, content scrollable */}
            <Tabs defaultValue="active" className="flex flex-col flex-1 overflow-hidden min-h-0">
              <TabsList className="rounded-xl bg-white/10 backdrop-blur-sm p-1 h-auto border border-white/20 shrink-0 mb-4">
                <TabsTrigger value="active" className="rounded-lg py-2.5 px-6 font-semibold data-[state=active]:bg-card data-[state=active]:shadow-sm">
                  Active ({activeEntries.length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="rounded-lg py-2.5 px-6 font-semibold data-[state=active]:bg-card data-[state=active]:shadow-sm">
                  Completed ({completedEntries.length})
                </TabsTrigger>
              </TabsList>

              {/* Scrollable entry cards area */}
              <div className="relative flex-1 min-h-0">
                <div className="absolute inset-0 overflow-y-auto pb-8 my-entries-scroll">
                  <TabsContent value="active" className="space-y-4 mt-0">
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

                  <TabsContent value="completed" className="space-y-4 mt-0">
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
                </div>

                {/* Bottom fade gradient */}
                <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background/80 to-transparent pointer-events-none z-10" />
              </div>
            </Tabs>
          </div>
        </main>
      </div>

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
        />
      )}
    </div>
  );
};

export default MyEntries;
