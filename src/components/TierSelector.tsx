import { formatCents } from "@/lib/formatCurrency";
import { Zap, Star } from "lucide-react";
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

export function TierSelector({ tiers, selectedTier, onSelectTier, walletBalanceCents }: TierSelectorProps) {
  // Find best value tier (highest 1st-place payout ratio)
  const bestValueIdx = tiers.reduce((bestIdx, tier, idx) => {
    const ratio = (tier.payout_structure["1"] || 0) / tier.entry_fee_cents;
    const bestRatio = (tiers[bestIdx].payout_structure["1"] || 0) / tiers[bestIdx].entry_fee_cents;
    return ratio > bestRatio ? idx : bestIdx;
  }, 0);

  // Only show "Best Value" on the highest-fee tier if it actually has the best ratio
  const highestFeeIdx = tiers.reduce((hi, t, i) => t.entry_fee_cents > tiers[hi].entry_fee_cents ? i : hi, 0);
  const showBestValue = bestValueIdx === highestFeeIdx;

  return (
    <div className="space-y-2 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-4 w-4 text-accent" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Choose Your Entry Level</span>
      </div>
      {tiers.map((tier, idx) => {
        const isSelected = selectedTier?.name === tier.name;
        const firstPrize = tier.payout_structure["1"] || 0;
        const additionalPlaces = Object.keys(tier.payout_structure).length - 1;
        const insufficientBalance = walletBalanceCents !== null && walletBalanceCents < tier.entry_fee_cents;

        return (
          <button
            key={tier.name}
            type="button"
            disabled={insufficientBalance}
            onClick={() => !insufficientBalance && onSelectTier(tier)}
            className={`w-full text-left rounded-lg p-3 border-2 transition-all ${
              insufficientBalance
                ? "opacity-50 cursor-not-allowed border-border bg-muted/30"
                : isSelected
                  ? "border-accent bg-accent/5 shadow-sm cursor-pointer"
                  : "border-border hover:border-muted-foreground/30 bg-card cursor-pointer"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {/* Radio indicator */}
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  isSelected ? "border-accent" : "border-muted-foreground/40"
                }`}>
                  {isSelected && <div className="w-2 h-2 rounded-full bg-accent" />}
                </div>
                <span className="font-semibold text-sm">{tier.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {showBestValue && idx === highestFeeIdx && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-gold/40 text-gold">
                    <Star className="h-2.5 w-2.5 mr-0.5 fill-gold" />Best
                  </Badge>
                )}
                {isSelected && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-accent/10 text-accent border-accent/20">
                    ✓ SELECTED
                  </Badge>
                )}
              </div>
            </div>
            <div className="ml-6.5 mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" style={{ marginLeft: '1.625rem' }}>
              <span className="font-medium text-foreground">{formatCents(tier.entry_fee_cents)}</span>
              <span>entry</span>
              <span className="mx-0.5">→</span>
              <span>Win</span>
              <span className="font-medium text-gold">{formatCents(firstPrize)}</span>
              {additionalPlaces > 0 && (
                <span className="text-muted-foreground">+ {additionalPlaces} more</span>
              )}
            </div>
            {insufficientBalance && (
              <p className="text-[10px] text-destructive mt-1" style={{ marginLeft: '1.625rem' }}>Insufficient balance</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
