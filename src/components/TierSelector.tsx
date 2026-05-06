// All money values must route through src/lib/formatCurrency.ts. Direct division by 100 in JSX is a bug.
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
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Choose Your Entry Level</p>

      <div className="flex gap-2">
        {tiers.map((tier) => {
          const isSelected = selectedTier?.name === tier.name;
          const insufficientBalance = walletBalanceCents !== null && walletBalanceCents < tier.entry_fee_cents;
          const displayFee = formatCents(tier.entry_fee_cents);

          return (
            <button
              key={tier.name}
              type="button"
              disabled={insufficientBalance}
              onClick={() => !insufficientBalance && onSelectTier(tier)}
              className={`flex-1 min-w-0 rounded-lg py-3 text-center font-bold text-lg transition-all duration-150 ${
                insufficientBalance
                  ? "bg-slate-100 border border-slate-200 text-slate-400 opacity-50 cursor-not-allowed"
                  : isSelected
                    ? "bg-accent text-white border-2 border-accent shadow-md scale-105"
                    : "bg-slate-100 border border-slate-200 text-slate-700 hover:bg-slate-200 cursor-pointer"
              }`}
            >
              {displayFee}
            </button>
          );
        })}
      </div>

      {selectedTier ? (
        <div className="mt-2 rounded-md bg-slate-50 border border-slate-200 p-2.5 animate-fade-in">
          <p className="text-sm text-slate-900 font-medium mb-1">{selectedTier.name} Tier</p>
          <div className="space-y-0.5">
            {Object.entries(selectedTier.payout_structure)
              .map(([rank, cents]) => ({ rank: Number(rank), cents }))
              .sort((a, b) => a.rank - b.rank)
              .map(({ rank, cents }) => (
                <div key={rank} className="flex justify-between text-xs">
                  <span className={rank === 1 ? "text-amber-600 font-medium" : "text-slate-500"}>{ordinal(rank)} place</span>
                  <span className={rank === 1 ? "text-amber-600 font-bold" : "font-medium text-slate-700"}>{formatCents(cents)}</span>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400 mt-2 text-center">Tap an amount to see prizes</p>
      )}
    </div>
  );
}
