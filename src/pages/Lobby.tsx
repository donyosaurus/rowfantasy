import { useState, useEffect, useMemo } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ContestCard } from "@/components/ContestCard";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

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
  contest_templates: {
    regatta_name: string;
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
  entryTiers: number;
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

      // Fetch pools and optionally user entries in parallel
      const poolsPromise = supabase
        .from("contest_pools")
        .select(
          `
           id,
           contest_template_id,
           lock_time,
           status,
           entry_fee_cents,
           prize_pool_cents,
           payout_structure,
           current_entries,
           max_entries,
           allow_overflow,
           created_at,
           contest_templates(regatta_name),
           contest_pool_crews(event_id)
         `,
        )
        .in("status", ["open", "locked"]);

      const userEntriesPromise = user
        ? supabase
            .from("contest_entries")
            .select("pool_id, contest_template_id")
            .eq("user_id", user.id)
            .in("status", ["active", "confirmed", "scored"])
        : Promise.resolve({ data: null, error: null });

      const [poolsResult, entriesResult] = await Promise.all([poolsPromise, userEntriesPromise]);

      if (poolsResult.error) {
        console.error("Error fetching contests:", poolsResult.error);
        setLoading(false);
        return;
      }

      const enteredTemplateIds = new Set(
        (entriesResult.data || []).map((e: any) => e.contest_template_id)
      );

      const mapped: MappedContest[] = (poolsResult.data as unknown as ContestPool[]).map((pool) => {
        const regattaName = pool.contest_templates?.regatta_name || "Unknown Regatta";
        const genderCategory: "Men's" | "Women's" = regattaName.toLowerCase().includes("women") ? "Women's" : "Men's";

        const divisions = [...new Set(pool.contest_pool_crews?.map((c) => c.event_id) || [])];

        const lockTime = new Date(pool.lock_time).toLocaleString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        return {
          id: pool.id,
          contestTemplateId: pool.contest_template_id,
          regattaName,
          genderCategory,
          lockTime,
          lockTimeRaw: pool.lock_time,
          divisions,
          entryTiers: 1,
          entryFeeCents: pool.entry_fee_cents,
          payoutStructure: pool.payout_structure,
          prizePoolCents: pool.prize_pool_cents,
          currentEntries: pool.current_entries || 0,
          maxEntries: pool.max_entries || 0,
          allowOverflow: pool.allow_overflow || false,
          createdAt: pool.created_at,
          status: pool.status,
          siblingPoolCount: 1,
          userEntered: enteredTemplateIds.has(pool.contest_template_id),
        };
      });

      // Group by contest_template_id so overflow pools don't create duplicate cards
      const grouped = mapped.reduce(
        (acc, contest) => {
          const key = contest.contestTemplateId;
          if (!acc[key]) acc[key] = [];
          acc[key].push(contest);
          return acc;
        },
        {} as Record<string, MappedContest[]>,
      );

      // Pick ONE representative card per contest template
      const deduplicated = Object.values(grouped).map((pools) => {
        const siblingPoolCount = pools.length;
        const userEntered = pools.some((p) => p.userEntered);

        // Sort: open pools with space first, then by creation date (oldest first)
        const sorted = [...pools].sort((a, b) => {
          const aOpen = a.status === "open" && a.currentEntries < a.maxEntries ? 1 : 0;
          const bOpen = b.status === "open" && b.currentEntries < b.maxEntries ? 1 : 0;
          if (aOpen !== bOpen) return bOpen - aOpen;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        return { ...sorted[0], siblingPoolCount, userEntered };
      });

      setContests(deduplicated);
      setLoading(false);
    };

    fetchContests();
  }, [user]);

  // Apply search and filter — runs client-side on the deduplicated list
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

      <main className="flex-1 bg-background py-16">
        <div className="container mx-auto px-4">
          <div className="mb-12 text-center max-w-3xl mx-auto">
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Available Contests</h1>
            <p className="text-xl text-muted-foreground">Browse open contests and enter to compete</p>
          </div>

          {/* Filters */}
          <div className="mb-8 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by event or race..."
                className="pl-10"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <Select value={genderFilter} onValueChange={setGenderFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Gender" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="mens">Men's</SelectItem>
                <SelectItem value="womens">Women's</SelectItem>
              </SelectContent>
            </Select>

            <Select value={lockFilter} onValueChange={setLockFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Lock Time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Times</SelectItem>
                <SelectItem value="soon">Next 6 hours</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">This Week</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Contest Grid */}
          {!loading && filteredContests.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredContests.map((contest) => (
                <ContestCard
                  key={contest.id}
                  id={contest.id}
                  regattaName={contest.regattaName}
                  genderCategory={contest.genderCategory}
                  lockTime={contest.lockTime}
                  divisions={contest.divisions}
                  entryTiers={contest.entryTiers}
                  payoutStructure={contest.payoutStructure}
                  prizePoolCents={contest.prizePoolCents}
                  currentEntries={contest.currentEntries}
                  maxEntries={contest.maxEntries}
                  allowOverflow={contest.allowOverflow}
                  siblingPoolCount={contest.siblingPoolCount}
                  userEntered={contest.userEntered}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && filteredContests.length === 0 && (
            <div className="text-center py-16">
              <p className="text-xl text-muted-foreground mb-4">
                {searchTerm || genderFilter !== "all" || lockFilter !== "all"
                  ? "No contests match your filters"
                  : "No contests available right now"}
              </p>
              <p className="text-muted-foreground">
                {searchTerm || genderFilter !== "all" || lockFilter !== "all"
                  ? "Try adjusting your search or filters"
                  : "Check back soon for new contests"}
              </p>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default Lobby;
