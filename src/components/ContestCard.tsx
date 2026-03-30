import { Link } from "react-router-dom";
import { formatCents } from "@/lib/formatCurrency";
import { Trophy } from "lucide-react";

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
  entryFeeCents?: number;
  payoutStructure?: Record<string, number> | null;
  prizePoolCents?: number;
  currentEntries?: number;
  maxEntries?: number;
  hasOverflow?: boolean;
  userEntered?: boolean;
  entryTiers?: EntryTier[] | null;
  bannerUrl?: string | null;
  events?: string[];
}

const CARD_GRADIENTS = [
  'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)',
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
  'linear-gradient(135deg, #0c1222 0%, #1b3a4b 100%)',
  'linear-gradient(135deg, #1a0e2e 0%, #2d1b69 100%)',
  'linear-gradient(135deg, #1e1e1e 0%, #2d3436 100%)',
  'linear-gradient(135deg, #0a1628 0%, #1a3c34 100%)',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getCountdown(lockTimeRaw?: string): string | null {
  if (!lockTimeRaw) return null;
  const lockDate = new Date(lockTimeRaw);
  const now = new Date();
  const diffMs = lockDate.getTime() - now.getTime();
  if (diffMs <= 0) return "Locked";
  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${totalMinutes}m`;
}

function formatFee(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars}`;
  return `$${dollars.toFixed(2)}`;
}

const MAX_VISIBLE_EVENTS = 4;

const EventPills = ({ events }: { events: string[] }) => {
  if (!events || events.length === 0) return null;
  const visible = events.slice(0, MAX_VISIBLE_EVENTS);
  const remaining = events.length - MAX_VISIBLE_EVENTS;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2 mb-3">
      {visible.map((evt) => (
        <span
          key={evt}
          className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 text-xs font-semibold text-slate-600 border border-slate-200"
        >
          {evt}
        </span>
      ))}
      {remaining > 0 && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-50 text-xs font-medium text-slate-400 border border-slate-100">
          +{remaining} more
        </span>
      )}
    </div>
  );
};

export const ContestCard = ({
  id,
  regattaName,
  genderCategory,
  lockTime,
  lockTimeRaw,
  entryFeeCents = 0,
  payoutStructure,
  prizePoolCents = 0,
  currentEntries = 0,
  maxEntries = 0,
  hasOverflow = false,
  userEntered = false,
  entryTiers = null,
  bannerUrl = null,
  events = [],
}: ContestCardProps) => {
  const hasTiers = entryTiers && entryTiers.length > 0;
  const hasPayoutStructure = payoutStructure && Object.keys(payoutStructure).length > 0;
  const firstPlacePrize = hasPayoutStructure ? payoutStructure["1"] : 0;
  const totalPrizes = hasPayoutStructure
    ? Object.values(payoutStructure).reduce((sum, val) => sum + val, 0)
    : prizePoolCents;

  const maxTierFirstPrize = hasTiers
    ? Math.max(...entryTiers.map(t => t.payout_structure["1"] || 0))
    : 0;

  // Show entries + fill bar ONLY for plain contests (no tiers, no overflow)
  const isPlainContest = !hasTiers && !hasOverflow;
  const showFillBar = isPlainContest && maxEntries > 0;
  const fillPercent = maxEntries > 0 ? (currentEntries / maxEntries) * 100 : 0;
  const entriesDisplay = `${currentEntries}/${maxEntries}`;

  // Contest type for tiered or overflow contests
  const contestType = maxEntries === 2 ? 'Head to Head' : `${maxEntries} Player Pool`;

  const countdown = getCountdown(lockTimeRaw);
  const gradientIndex = hashString(regattaName) % CARD_GRADIENTS.length;

  const prizeDisplay = hasTiers
    ? `Up to ${formatCents(maxTierFirstPrize)}`
    : hasPayoutStructure
      ? formatCents(firstPlacePrize)
      : formatCents(totalPrizes);

  const entryDisplay = entryFeeCents > 0 ? formatCents(entryFeeCents) : "Free";

  const lockTimeFormatted = lockTimeRaw
    ? new Date(lockTimeRaw).toLocaleString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : lockTime;

  const fillBarColor = fillPercent >= 100
    ? "bg-gradient-to-r from-red-400 to-red-500"
    : fillPercent > 80
      ? "bg-gradient-to-r from-amber-400 to-amber-500"
      : "bg-gradient-to-r from-teal-400 to-teal-500";

  // Build tier fee display string
  const tierFeeDisplay = hasTiers
    ? entryTiers
        .sort((a, b) => a.entry_fee_cents - b.entry_fee_cents)
        .map(t => formatFee(t.entry_fee_cents))
        .join("  ·  ")
    : "";

  return (
    <Link to={`/regatta/${id}`} className="block group h-full">
      <div className="rounded-xl overflow-hidden bg-white shadow-md hover:shadow-xl transition-all duration-300 hover:-translate-y-1 border border-slate-200/80 flex flex-col h-full">
        {/* Banner Area */}
        <div className="relative h-40 overflow-hidden bg-[#0c2340]">
          {bannerUrl ? (
            <img
              src={bannerUrl}
              alt={regattaName}
              className="w-full h-full object-contain"
              onError={(e) => {
                const target = e.currentTarget;
                target.style.display = 'none';
                const fallback = target.nextElementSibling as HTMLElement;
                if (fallback) fallback.style.display = 'flex';
              }}
            />
          ) : null}
          <div
            className={`absolute inset-0 flex items-center justify-center ${bannerUrl ? 'hidden' : ''}`}
            style={{ background: CARD_GRADIENTS[gradientIndex] }}
          >
            <span className="text-white/20 text-3xl font-bold text-center px-6 select-none">
              {regattaName}
            </span>
          </div>

          {countdown && countdown !== "Locked" && (
            <div className="absolute bottom-3 left-3 bg-black/60 text-white text-xs font-semibold px-3 py-1 rounded-full backdrop-blur-sm">
              {countdown}
            </div>
          )}
          {countdown === "Locked" && (
            <div className="absolute bottom-3 left-3 bg-red-600/80 text-white text-xs font-semibold px-3 py-1 rounded-full backdrop-blur-sm">
              Locked
            </div>
          )}

          {userEntered && (
            <div className="absolute top-3 right-3 bg-emerald-500/90 text-white text-xs font-semibold px-3 py-1 rounded-full backdrop-blur-sm">
              ✓ Entered
            </div>
          )}
        </div>

        {/* Fill bar — only for plain contests */}
        {showFillBar && (
          <div className="h-1.5 bg-slate-200 group-hover:h-2 transition-all duration-300">
            <div
              className={`h-full ${fillBarColor} rounded-r-full transition-all duration-500`}
              style={{ width: `${Math.min(fillPercent, 100)}%` }}
            />
          </div>
        )}

        {/* Info Area */}
        <div className="p-4 bg-white flex-1 flex flex-col">
          <div className="border-l-4 border-teal-400 pl-3">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500 group-hover:scale-110 transition-transform flex-shrink-0" />
              <h3 className="text-lg font-bold text-slate-900 line-clamp-1">{regattaName}</h3>
            </div>
            <div className="flex items-center gap-1.5 mt-1 line-clamp-1">
              <span className="text-sm text-slate-500">{genderCategory}</span>
              <span className="text-slate-300">·</span>
              <span className="text-sm text-slate-500">Locks {lockTimeFormatted}</span>
            </div>
          </div>

          {/* Event pills */}
          <EventPills events={events} />

          <div className="flex gap-2 mt-auto pt-4">
            {isPlainContest ? (
              /* Plain contest: Entries + Entry fee + Prizes */
              <>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-base font-bold text-slate-900">{entriesDisplay}</div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Entries</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-base font-bold text-teal-600">{entryDisplay}</div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Entry</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-base font-bold text-amber-600 flex items-center justify-center gap-1">
                    {prizeDisplay} 🏅
                  </div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Prizes</div>
                </div>
              </>
            ) : hasTiers ? (
              /* Tiered contest: Type + Tier fees + Prizes */
              <>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-sm font-bold text-slate-900">{contestType}</div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Type</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className={`font-bold text-teal-600 ${entryTiers.length > 3 ? 'text-xs' : 'text-sm'} leading-tight`}>
                    {tierFeeDisplay}
                  </div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Entry</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-sm font-bold text-amber-600 flex items-center justify-center gap-1">
                    {prizeDisplay} 🏅
                  </div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Prizes</div>
                </div>
              </>
            ) : (
              /* Overflow, no tiers: Type + Single fee + Prizes */
              <>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-sm font-bold text-slate-900">{contestType}</div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Type</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-base font-bold text-teal-600">{entryDisplay}</div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Entry</div>
                </div>
                <div className="bg-slate-50 group-hover:bg-slate-100 transition-colors rounded-lg px-3 py-2 text-center flex-1">
                  <div className="text-base font-bold text-amber-600 flex items-center justify-center gap-1">
                    {prizeDisplay} 🏅
                  </div>
                  <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mt-0.5">Prizes</div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
};
