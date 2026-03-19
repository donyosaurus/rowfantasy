import { Link } from "react-router-dom";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Clock, Trophy, Users, Infinity, Zap } from "lucide-react";
import { formatCents } from "@/lib/formatCurrency";

type GenderCategory = "Men's" | "Women's";

interface EntryTier {
  name: string;
  entry_fee_cents: number;
  payout_structure: Record<string, number>;
}

interface ContestCardProps {
  id: string;
  regattaName: string;
  genderCategory: GenderCategory;
  lockTime: string;
  lockTimeRaw?: string;
  divisions?: string[];
  entryFeeCents?: number;
  payoutStructure?: Record<string, number> | null;
  prizePoolCents?: number;
  currentEntries?: number;
  maxEntries?: number;
  allowOverflow?: boolean;
  siblingPoolCount?: number;
  userEntered?: boolean;
  entryTiers?: EntryTier[] | null;
}

export const ContestCard = ({
  id,
  regattaName,
  genderCategory,
  lockTime,
  lockTimeRaw,
  divisions = [],
  entryFeeCents = 0,
  payoutStructure,
  prizePoolCents = 0,
  currentEntries = 0,
  maxEntries = 0,
  allowOverflow = false,
  siblingPoolCount = 1,
  userEntered = false,
  entryTiers = null,
}: ContestCardProps) => {
  const hasTiers = entryTiers && entryTiers.length > 0;

  const hasPayoutStructure = payoutStructure && Object.keys(payoutStructure).length > 0;
  const firstPlacePrize = hasPayoutStructure ? payoutStructure["1"] : 0;
  const totalPrizes = hasPayoutStructure
    ? Object.values(payoutStructure).reduce((sum, val) => sum + val, 0)
    : prizePoolCents;

  // For tiered contests, find max 1st-place prize across tiers
  const maxTierFirstPrize = hasTiers
    ? Math.max(...entryTiers.map(t => t.payout_structure["1"] || 0))
    : 0;

  const isFull = maxEntries > 0 && currentEntries >= maxEntries;
  const hasMultiplePools = siblingPoolCount > 1;
  const fillPercent = maxEntries > 0 ? (currentEntries / maxEntries) * 100 : 0;

  const getCountdown = () => {
    if (!lockTimeRaw) return null;
    const lockDate = new Date(lockTimeRaw);
    const now = new Date();
    const hoursLeft = (lockDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursLeft <= 0) return "Locked";
    if (hoursLeft <= 1) return `${Math.ceil(hoursLeft * 60)}m left`;
    if (hoursLeft <= 24) return `${Math.ceil(hoursLeft)}h left`;
    return null;
  };

  const countdown = getCountdown();

  return (
    <Card className="flex flex-col h-full rounded-xl shadow-md card-hover border-border/40 overflow-hidden">
      <div className="h-1 gradient-hero" />
      
      <CardContent className="flex-1 p-6 space-y-4">
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-heading font-bold text-lg leading-tight">{regattaName}</h3>
            <div className="flex flex-col items-end gap-1.5">
              <Badge
                variant="secondary"
                className="flex-shrink-0 bg-primary/10 text-primary border-primary/20 font-semibold px-2.5 py-0.5 text-xs"
              >
                {genderCategory}
              </Badge>
              {hasMultiplePools && (
                <Badge variant="secondary" className="bg-accent/10 text-accent border-accent/20 text-xs">
                  <Infinity className="h-3 w-3 mr-1" />
                  Auto-Pool
                </Badge>
              )}
            </div>
          </div>
          
          {/* Entry Fee */}
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold">
              {entryFeeCents > 0 ? `${formatCents(entryFeeCents)} entry` : "Free entry"}
            </span>
          </div>
        </div>

        {/* Prize Pool */}
        {(firstPlacePrize > 0 || totalPrizes > 0) && (
          <div className="p-4 rounded-xl bg-gradient-to-br from-amber-50 to-yellow-50/50 dark:from-amber-950/30 dark:to-yellow-950/20 border border-amber-200/40 dark:border-amber-800/30">
            <div className="flex items-center gap-2 mb-1">
              <Trophy className="h-5 w-5 text-gold" />
              <span className="text-xl font-heading font-extrabold text-gold">
                {hasPayoutStructure ? formatCents(firstPlacePrize) : formatCents(totalPrizes)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground font-medium">
              {hasPayoutStructure ? `1st Place • ${formatCents(totalPrizes)} total` : "Prize Pool"}
            </p>
          </div>
        )}

        {/* Pool Capacity */}
        {maxEntries > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground"><Users className="h-4 w-4" />Entries</span>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{currentEntries}/{maxEntries}</span>
                {isFull && !hasMultiplePools && <Badge variant="destructive" className="text-xs">Full</Badge>}
              </div>
            </div>
            <Progress value={fillPercent} className="h-2" />
          </div>
        )}

        {/* Divisions */}
        {divisions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Events</p>
            <div className="flex flex-wrap gap-1.5">
              {divisions.slice(0, 3).map((division, idx) => (
                <Badge key={idx} variant="outline" className="font-normal text-xs">{division}</Badge>
              ))}
              {divisions.length > 3 && <Badge variant="outline" className="font-normal text-xs text-muted-foreground">+{divisions.length - 3} more</Badge>}
            </div>
          </div>
        )}

        {/* Lock Time */}
        <div className="flex items-center justify-between pt-3 border-t">
          <span className="flex items-center gap-1.5 text-muted-foreground text-sm"><Clock className="h-4 w-4" />Locks</span>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{lockTime}</span>
            {countdown && countdown !== "Locked" && (
              <Badge className="bg-destructive/10 text-destructive border-destructive/20 text-xs font-semibold">{countdown}</Badge>
            )}
          </div>
        </div>
      </CardContent>

      <CardFooter className="p-6 pt-0">
        <Link to={`/regatta/${id}`} className="w-full">
          <Button
            className={`w-full font-semibold py-6 rounded-xl text-base ${
              userEntered ? "bg-success/10 text-success border border-success/30 hover:bg-success/20" : ""
            }`}
            disabled={!userEntered && isFull && !allowOverflow && !hasMultiplePools}
            variant={userEntered ? "ghost" : "hero"}
          >
            {userEntered
              ? "✓ Entered"
              : isFull && (allowOverflow || hasMultiplePools)
                ? "Join Next Pool"
                : isFull
                  ? "Contest Full"
                  : "View Entry Options"}
          </Button>
        </Link>
      </CardFooter>
    </Card>
  );
};
