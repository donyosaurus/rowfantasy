import { useState, useEffect, useMemo } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ContestCard } from "@/components/ContestCard";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Loader2, Trophy, Waves } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { LobbyBackground } from "@/components/LobbyBackground";

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
  entry_tiers: unknown;
  contest_templates: {
    regatta_name: string;
    banner_url: string | null;
  };
  contest_pool_crews: {
    event_id: string;
  }[];
}

interface MappedContest {
  id: string;
  contestTemplateId: string;
  regattaName: string;
  genderCategory: "Men's" | "Women's";
  lockTime: string;
  lockTimeRaw: string;
  divisions: string[];
  entryFeeCents: number;
  payoutStructure: Record<string, number> | null;
  prizePoolCents: number;
  currentEntries: number;
  maxEntries: number;
  allowOverflow: boolean;
  createdAt: string;
  status: string;
  siblingPoolCount: number;
  userEntered: boolean;
  entryTiers: any[] | null;
  bannerUrl: string | null;
}

const Lobby = () => {
  const { user } = useAuth();
  const [contests, setContests] = useState<MappedContest[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [genderFilter, setGenderFilter] = useState("all");
  const [lockFilter, setLockFilter] = useState("all");

  useEffect(() => {
    const fetchContests = async () => {
      setLoading(true);

      const poolsPromise = supabase
        .from("contest_pools")
        .select(`
           id, contest_template_id, lock_time, status, entry_fee_cents,
           prize_pool_cents, payout_structure, current_entries, max_entries,
           allow_overflow, created_at, tier_id, entry_tiers,
           contest_templates(regatta_name, banner_url),
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

      const [poolsResult, entriesResult] = await Promise.all([poolsPromise, userEntriesPromise]);

      if (poolsResult.error) {
        console.error("Error fetching contests:", poolsResult.error);
        setLoading(false);
        return;
      }

      const enteredPoolIds = new Set(
        (entriesResult.data || []).map((e: any) => e.pool_id)
      );

      const allPools = poolsResult.data as unknown as ContestPool[];

      // Group by template
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

        // Pick representative pool (open with capacity, oldest)
        const sorted = [...pools].sort((a, b) => {
          const aOpen = a.status === "open" && a.current_entries < a.max_entries ? 1 : 0;
          const bOpen = b.status === "open" && b.current_entries < b.max_entries ? 1 : 0;
          if (aOpen !== bOpen) return bOpen - aOpen;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        const primary = sorted[0];

        const regattaName = primary.contest_templates?.regatta_name || "Unknown Regatta";
        const genderCategory: "Men's" | "Women's" = regattaName.toLowerCase().includes("women") ? "Women's" : "Men's";
        const divisions = [...new Set(primary.contest_pool_crews?.map((c) => c.event_id) || [])];
        const lockTime = new Date(primary.lock_time).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
        });

        return {
          id: primary.id,
          contestTemplateId: primary.contest_template_id,
          regattaName, genderCategory, lockTime,
          lockTimeRaw: primary.lock_time,
          divisions,
          entryFeeCents: primary.entry_fee_cents,
          payoutStructure: primary.payout_structure,
          prizePoolCents: primary.prize_pool_cents,
          currentEntries: primary.current_entries || 0,
          maxEntries: primary.max_entries || 0,
          allowOverflow: primary.allow_overflow || false,
          createdAt: primary.created_at,
          status: primary.status,
          siblingPoolCount, userEntered,
          entryTiers: (primary.entry_tiers as any[] | null) || null,
          bannerUrl: primary.contest_templates?.banner_url || null,
        };
      });

      setContests(deduplicated);
      setLoading(false);
    };

    fetchContests();
  }, [user]);

  const filteredContests = useMemo(() => {
    const now = new Date();
    return contests.filter((c) => {
      const matchSearch = c.regattaName.toLowerCase().includes(searchTerm.toLowerCase());
      const matchGender =
        genderFilter === "all" ||
        (genderFilter === "mens" && c.genderCategory === "Men's") ||
        (genderFilter === "womens" && c.genderCategory === "Women's");
      const lockDate = new Date(c.lockTimeRaw);
      const hoursUntilLock = (lockDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      const matchLock =
        lockFilter === "all" ||
        (lockFilter === "soon" && hoursUntilLock > 0 && hoursUntilLock <= 6) ||
        (lockFilter === "today" && lockDate.toDateString() === now.toDateString()) ||
        (lockFilter === "week" && hoursUntilLock > 0 && hoursUntilLock <= 168);
      return matchSearch && matchGender && matchLock;
    });
  }, [contests, searchTerm, genderFilter, lockFilter]);

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <section className="gradient-hero py-16 pb-24 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-10 left-10 w-64 h-64 rounded-full bg-accent blur-3xl" />
          <div className="absolute bottom-10 right-10 w-96 h-96 rounded-full bg-accent blur-3xl" />
        </div>
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-10">
            <h1 className="text-4xl md:text-5xl font-heading font-extrabold text-white mb-4 animate-fade-in">Available Contests</h1>
            <p className="text-lg text-white/70 animate-fade-in" style={{ animationDelay: "0.1s" }}>Pick your crews, predict the margin, win real prizes</p>
          </div>
          <div className="max-w-4xl mx-auto animate-fade-in" style={{ animationDelay: "0.2s" }}>
            <Card className="shadow-xl border-0 rounded-2xl">
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="relative md:col-span-2">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search contests..." className="pl-10 rounded-xl border-border/50" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                  </div>
                  <Select value={genderFilter} onValueChange={setGenderFilter}>
                    <SelectTrigger className="rounded-xl border-border/50"><SelectValue placeholder="Gender" /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="mens">Men's</SelectItem><SelectItem value="womens">Women's</SelectItem></SelectContent>
                  </Select>
                  <Select value={lockFilter} onValueChange={setLockFilter}>
                    <SelectTrigger className="rounded-xl border-border/50"><SelectValue placeholder="Lock Time" /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All Times</SelectItem><SelectItem value="soon">Next 6 hours</SelectItem><SelectItem value="today">Today</SelectItem><SelectItem value="week">This Week</SelectItem></SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <main className="flex-1 bg-background -mt-8 relative z-10">
        <div className="container mx-auto px-4 pb-16">
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

          {!loading && filteredContests.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredContests.map((contest, idx) => (
                <div key={contest.id} className="animate-fade-in" style={{ animationDelay: `${idx * 0.05}s` }}>
                  <ContestCard
                    id={contest.id}
                    regattaName={contest.regattaName}
                    genderCategory={contest.genderCategory}
                    lockTime={contest.lockTime}
                    lockTimeRaw={contest.lockTimeRaw}
                    divisions={contest.divisions}
                    entryFeeCents={contest.entryFeeCents}
                    payoutStructure={contest.payoutStructure}
                    prizePoolCents={contest.prizePoolCents}
                    currentEntries={contest.currentEntries}
                    maxEntries={contest.maxEntries}
                    allowOverflow={contest.allowOverflow}
                    siblingPoolCount={contest.siblingPoolCount}
                    userEntered={contest.userEntered}
                    entryTiers={contest.entryTiers}
                  />
                </div>
              ))}
            </div>
          )}

          {!loading && filteredContests.length === 0 && (
            <Card className="max-w-md mx-auto rounded-2xl shadow-lg border-border/40">
              <CardContent className="py-16 text-center">
                <div className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-6">
                  <Trophy className="h-10 w-10 text-accent" />
                </div>
                <h3 className="text-xl font-heading font-bold mb-2">
                  {searchTerm || genderFilter !== "all" || lockFilter !== "all" ? "No contests match your filters" : "No contests available yet"}
                </h3>
                <p className="text-muted-foreground">
                  {searchTerm || genderFilter !== "all" || lockFilter !== "all" ? "Try adjusting your search or filters" : "New contests are posted regularly — check back soon!"}
                </p>
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
