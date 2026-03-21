import { formatCents } from "@/lib/formatCurrency";
import { Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface EntryTier {
  name: string;
  entry_fee_cents: number;
  payout_structure: Record<string, number>;
}

interface TierSelectorProps {
  tiers: EntryTier[];
  selectedTier: EntryTier | null;
  onSelectTier: (tier: EntryTier) => void;
  walletBalanceCents: number | null;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function TierSelector({ tiers, selectedTier, onSelectTier, walletBalanceCents }: TierSelectorProps) {
  // Find best value tier (highest 1st-place payout ratio)
  const bestValueIdx = tiers.reduce((bestIdx, tier, idx) => {
    const ratio = (tier.payout_structure["1"] || 0) / tier.entry_fee_cents;
    const bestRatio = (tiers[bestIdx].payout_structure["1"] || 0) / tiers[bestIdx].entry_fee_cents;
    return ratio > bestRatio ? idx : bestIdx;
  }, 0);

  const highestFeeIdx = tiers.reduce((hi, t, i) => t.entry_fee_cents > tiers[hi].entry_fee_cents ? i : hi, 0);
  const showBestValue = bestValueIdx === highestFeeIdx;

  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Choose Your Entry Level</p>

      {/* Compact horizontal tier buttons */}
      <div className="flex gap-2 overflow-x-auto">
        {tiers.map((tier, idx) => {
          const isSelected = selectedTier?.name === tier.name;
          const insufficientBalance = walletBalanceCents !== null && walletBalanceCents < tier.entry_fee_cents;
          const dollars = tier.entry_fee_cents / 100;
          const displayFee = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;

          return (
            <button
              key={tier.name}
              type="button"
              disabled={insufficientBalance}
              onClick={() => !insufficientBalance && onSelectTier(tier)}
              className={`flex-1 min-w-0 rounded-lg px-3 py-2.5 text-center transition-all duration-200 border-2 ${
                insufficientBalance
                  ? "opacity-40 cursor-not-allowed border-border bg-muted/30"
                  : isSelected
                    ? "border-accent bg-accent/15 scale-105 shadow-sm"
                    : "border-border bg-secondary hover:bg-muted hover:border-muted-foreground/40 cursor-pointer"
              }`}
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium block">{tier.name}</span>
              <span className={`text-base font-bold block ${isSelected ? "text-accent" : "text-foreground"}`}>{displayFee}</span>
              {showBestValue && idx === highestFeeIdx && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-gold font-semibold mt-0.5">
                  <Star className="h-2.5 w-2.5 fill-gold text-gold" />Best
                </span>
              )}
              {insufficientBalance && (
                <span className="text-[9px] text-destructive block mt-0.5">Low balance</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected tier payout reveal */}
      {selectedTier ? (
        <div className="mt-2 rounded-md bg-accent/5 border border-accent/20 p-2.5 animate-fade-in">
          <p className="text-xs font-semibold text-foreground mb-1">{selectedTier.name} Tier</p>
          <div className="space-y-0.5">
            {Object.entries(selectedTier.payout_structure)
              .map(([rank, cents]) => ({ rank: Number(rank), cents }))
              .sort((a, b) => a.rank - b.rank)
              .map(({ rank, cents }) => (
                <div key={rank} className="flex justify-between text-xs">
                  <span className={rank === 1 ? "text-gold font-medium" : "text-muted-foreground"}>{ordinal(rank)} place</span>
                  <span className={rank === 1 ? "text-gold font-bold" : "font-medium"}>{formatCents(cents)}</span>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground mt-1.5 text-center">Tap a tier to see prizes</p>
      )}
    </div>
  );
}
