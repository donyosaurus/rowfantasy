import { useState, useEffect, useMemo } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ContestCard } from "@/components/ContestCard";
import { Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { LobbyBackground } from "@/components/LobbyBackground";
import { ContestGroupSection } from "@/components/lobby/ContestGroupSection";

interface ContestPool {
  id: string;
  contest_template_id: string;
  lock_time: string;
  status: string;
  entry_fee_cents: number;
  prize_pool_cents: number;
  payout_structure: Record<string, number> | null;
  current_entries: number;
  max_entries: number;
  allow_overflow: boolean;
  created_at: string;
  tier_id: string;
  tier_name: string | null;
  entry_tiers: unknown;
  contest_templates: {
    regatta_name: string;
    card_banner_url: string | null;
    contest_group_id: string | null;
    display_order_in_group: number;
  };
  contest_pool_crews: {
    event_id: string;
  }[];
}

interface ContestGroup {
  id: string;
  name: string;
  description: string | null;
  display_order: number;
}

interface MappedContest {
  id: string;
  contestTemplateId: string;
  regattaName: string;
  genderCategory: "Men's" | "Women's";
  lockTime: string;
  lockTimeRaw: string;
  entryFeeCents: number;
  payoutStructure: Record<string, number> | null;
  prizePoolCents: number;
  currentEntries: number;
  maxEntries: number;
  hasOverflow: boolean;
  createdAt: string;
  status: string;
  userEntered: boolean;
  entryTiers: any[] | null;
  bannerUrl: string | null;
  contestGroupId: string | null;
  displayOrderInGroup: number;
  events: string[];
}

const Lobby = () => {
  const { user } = useAuth();
  const [contests, setContests] = useState<MappedContest[]>([]);
  const [groups, setGroups] = useState<ContestGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchContests = async () => {
      setLoading(true);

      const poolsPromise = supabase
        .from("contest_pools")
        .select(`
           id, contest_template_id, lock_time, status, entry_fee_cents,
           prize_pool_cents, payout_structure, current_entries, max_entries,
           allow_overflow, created_at, tier_id, tier_name, entry_tiers,
           contest_templates(regatta_name, card_banner_url, contest_group_id, display_order_in_group),
           contest_pool_crews(event_id)
         `)
        .in("status", ["open", "locked"]);

      const userEntriesPromise = user
        ? supabase
            .from("contest_entries")
            .select("pool_id")
            .eq("user_id", user.id)
            .in("status", ["active", "confirmed", "scored"])
        : Promise.resolve({ data: null, error: null });

      const groupsPromise = supabase
        .from("contest_groups")
        .select("id, name, description, display_order")
        .eq("is_visible", true)
        .order("display_order");

      const [poolsResult, entriesResult, groupsResult] = await Promise.all([poolsPromise, userEntriesPromise, groupsPromise]);

      if (poolsResult.error) {
        console.error("Error fetching contests:", poolsResult.error);
        setLoading(false);
        return;
      }

      setGroups(groupsResult.data || []);

      const enteredPoolIds = new Set(
        (entriesResult.data || []).map((e: any) => e.pool_id)
      );

      const allPools = poolsResult.data as unknown as ContestPool[];

      const grouped = allPools.reduce((acc, pool) => {
        const key = pool.contest_template_id;
        if (!key) return acc;
        if (!acc[key]) acc[key] = [];
        acc[key].push(pool);
        return acc;
      }, {} as Record<string, ContestPool[]>);

      const deduplicated: MappedContest[] = Object.values(grouped).map((pools) => {
        const userEntered = pools.some((p) => enteredPoolIds.has(p.id));
        const siblingPoolCount = pools.length;

        // Pick a representative pool for display (prefer open with capacity)
        const sorted = [...pools].sort((a, b) => {
          const aOpen = a.status === "open" && a.current_entries < a.max_entries ? 1 : 0;
          const bOpen = b.status === "open" && b.current_entries < b.max_entries ? 1 : 0;
          if (aOpen !== bOpen) return bOpen - aOpen;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        const primary = sorted[0];

        const regattaName = primary.contest_templates?.regatta_name || "Unknown Regatta";
        const genderCategory: "Men's" | "Women's" = regattaName.toLowerCase().includes("women") ? "Women's" : "Men's";
        const lockTime = new Date(primary.lock_time).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
        });

        // Detect tiers: distinct tier_name values (excluding null)
        const tierNames = [...new Set(pools.map(p => p.tier_name).filter(Boolean))];
        const hasTiers = tierNames.length > 1;
        const hasOverflow = pools.some(p => p.allow_overflow);

        // For tiered contests, maxEntries is per-tier (all tiers share same max)
        // For non-tiered, aggregate across all pools
        const perTierMax = pools[0]?.max_entries || 0;
        let displayCurrentEntries: number;
        let displayMaxEntries: number;

        if (hasTiers) {
          displayMaxEntries = perTierMax;
          displayCurrentEntries = 0; // not meaningful for tiered
        } else if (hasOverflow) {
          displayMaxEntries = perTierMax;
          displayCurrentEntries = 0;
        } else {
          displayCurrentEntries = pools.reduce((sum, p) => sum + p.current_entries, 0);
          displayMaxEntries = pools.reduce((sum, p) => sum + p.max_entries, 0);
        }

        // For display: lowest entry fee, highest first-place prize
        const lowestFee = Math.min(...pools.map(p => p.entry_fee_cents));
        const highestFirstPrize = Math.max(...pools.map(p => {
          const ps = p.payout_structure;
          return ps && ps["1"] ? ps["1"] : 0;
        }));

        // Build entry tiers info for the card
        const entryTiersForCard = hasTiers ? tierNames.map(name => {
          const tierPool = pools.find(p => p.tier_name === name);
          return {
            name: name!,
            entry_fee_cents: tierPool?.entry_fee_cents ?? 0,
            payout_structure: tierPool?.payout_structure ?? {},
          };
        }) : null;

        return {
          id: primary.id,
          contestTemplateId: primary.contest_template_id,
          regattaName, genderCategory, lockTime,
          lockTimeRaw: primary.lock_time,
          entryFeeCents: hasTiers ? lowestFee : primary.entry_fee_cents,
          payoutStructure: primary.payout_structure,
          prizePoolCents: hasTiers ? highestFirstPrize : primary.prize_pool_cents,
          currentEntries: displayCurrentEntries,
          maxEntries: displayMaxEntries,
          hasOverflow,
          createdAt: primary.created_at,
          status: primary.status,
          userEntered,
          entryTiers: entryTiersForCard,
          bannerUrl: primary.contest_templates?.card_banner_url || null,
          contestGroupId: primary.contest_templates?.contest_group_id || null,
          displayOrderInGroup: primary.contest_templates?.display_order_in_group || 0,
          events: [...new Set(pools.flatMap(p => (p.contest_pool_crews || []).map(c => c.event_id)).filter(Boolean))],
        };
      });

      setContests(deduplicated);
      setLoading(false);
    };

    fetchContests();
  }, [user]);

  const hasGroups = groups.length > 0;

  const groupedSections = useMemo(() => {
    if (!hasGroups) return null;

    const sections: { group: ContestGroup; contests: MappedContest[] }[] = groups.map(g => ({
      group: g,
      contests: contests
        .filter(c => c.contestGroupId === g.id)
        .sort((a, b) => a.displayOrderInGroup - b.displayOrderInGroup || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }));

    const ungrouped = contests
      .filter(c => !c.contestGroupId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return { sections, ungrouped };
  }, [contests, groups, hasGroups]);

  return (
    <div className="flex flex-col min-h-screen relative">
      <LobbyBackground />
      <Header />

      <section className="gradient-hero py-16 pb-24 relative overflow-hidden z-10">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-10 left-10 w-64 h-64 rounded-full bg-accent blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 rounded-full bg-accent blur-3xl" />
        </div>
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center max-w-3xl mx-auto">
            <h1 className="text-4xl md:text-5xl font-heading font-extrabold text-white mb-4 animate-fade-in">Available Contests</h1>
            <p className="text-lg text-white/70 animate-fade-in" style={{ animationDelay: "0.1s" }}>Pick your crews, predict the margin, win real prizes</p>
          </div>
        </div>
      </section>

      <main className="flex-1 relative z-10">
        <div className="container mx-auto px-4 pb-16 pt-12">
          {loading && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="rounded-xl overflow-hidden">
                  <div className="h-1 bg-muted" />
                  <CardContent className="p-6 space-y-4">
                    <Skeleton className="h-6 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-20 w-full rounded-xl" /><Skeleton className="h-4 w-full" /><Skeleton className="h-10 w-full rounded-xl" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!loading && contests.length > 0 && hasGroups && groupedSections && (
            <div>
              {groupedSections.sections.map((s) => (
                <ContestGroupSection
                  key={s.group.id}
                  title={s.group.name}
                  description={s.group.description}
                  contests={s.contests}
                />
              ))}
              {groupedSections.ungrouped.length > 0 && (
                <ContestGroupSection
                  title="More Contests"
                  contests={groupedSections.ungrouped}
                />
              )}
            </div>
          )}

          {!loading && contests.length > 0 && !hasGroups && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch relative z-0">
              {contests.map((contest, idx) => (
                <div key={contest.id} className="animate-fade-in" style={{ animationDelay: `${idx * 0.05}s` }}>
                  <ContestCard
                    id={contest.id}
                    regattaName={contest.regattaName}
                    genderCategory={contest.genderCategory}
                    lockTime={contest.lockTime}
                    lockTimeRaw={contest.lockTimeRaw}
                    entryFeeCents={contest.entryFeeCents}
                    payoutStructure={contest.payoutStructure}
                    prizePoolCents={contest.prizePoolCents}
                    currentEntries={contest.currentEntries}
                    maxEntries={contest.maxEntries}
                    hasOverflow={contest.hasOverflow}
                    userEntered={contest.userEntered}
                    entryTiers={contest.entryTiers}
                    bannerUrl={contest.bannerUrl}
                    events={contest.events}
                  />
                </div>
              ))}
            </div>
          )}

          {!loading && contests.length === 0 && (
            <Card className="max-w-md mx-auto rounded-2xl shadow-lg border-border/40">
              <CardContent className="py-16 text-center">
                <div className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6">
                  <Trophy className="h-10 w-10 text-accent" />
                </div>
                <h3 className="text-xl font-heading font-bold mb-2">No contests available yet</h3>
                <p className="text-muted-foreground">New contests are posted regularly — check back soon!</p>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default Lobby;
