import { formatCents } from "@/lib/formatCurrency";

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
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Choose Your Entry Level</p>

      <div className="flex gap-2">
        {tiers.map((tier) => {
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
              className={`flex-1 min-w-0 rounded-lg py-3 text-center font-bold text-lg transition-all duration-150 ${
                insufficientBalance
                  ? "bg-secondary border border-border text-muted-foreground opacity-40 cursor-not-allowed"
                  : isSelected
                    ? "bg-accent text-accent-foreground border-2 border-accent shadow-md scale-105"
                    : "bg-secondary border border-border text-foreground hover:bg-muted cursor-pointer"
              }`}
            >
              {displayFee}
            </button>
          );
        })}
      </div>

      {selectedTier ? (
        <div className="mt-2 rounded-md bg-secondary border border-border p-2.5 animate-fade-in">
          <p className="text-sm text-foreground font-medium mb-1">{selectedTier.name} Tier</p>
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
        <p className="text-xs text-muted-foreground mt-2 text-center">Tap an amount to see prizes</p>
      )}
    </div>
  );
}
