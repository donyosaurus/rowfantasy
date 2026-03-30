import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { type EntryTier } from "@/components/TierSelector";
import { formatCents } from "@/lib/formatCurrency";

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

function formatCountdown(lockTime: string): string {
  const diff = new Date(lockTime).getTime() - Date.now();
  if (diff <= 0) return "Locked";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatFee(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars}`;
  return `$${dollars.toFixed(2)}`;
}

interface ContestBannerHeaderProps {
  regattaName: string;
  genderCategory: string;
  lockTime: string;
  status: string;
  bannerUrl?: string | null;
  maxEntries: number;
  entryFeeCents: number;
  entryTiers?: EntryTier[] | null;
  allowOverflow?: boolean;
}

export const ContestBannerHeader = ({
  regattaName,
  genderCategory,
  lockTime,
  status,
  bannerUrl,
  maxEntries,
  entryFeeCents,
  entryTiers,
  allowOverflow,
}: ContestBannerHeaderProps) => {
  const navigate = useNavigate();
  const [countdown, setCountdown] = useState(() => formatCountdown(lockTime));

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(formatCountdown(lockTime));
    }, 60000);
    return () => clearInterval(interval);
  }, [lockTime]);

  const isOpen = status === "open" && new Date(lockTime) > new Date();
  const isLocked = !isOpen && (status === "locked" || status === "open");
  const isSettled = status === "completed" || status === "settled";

  const gradientIndex = hashString(regattaName) % CARD_GRADIENTS.length;

  // Build subtitle
  const hasTiers = entryTiers && entryTiers.length > 1;
  const contestType = maxEntries === 2 ? "Head to Head" : `${maxEntries} Player Pool`;

  const subtitleParts: string[] = [genderCategory, contestType];
  if (hasTiers) {
    const sorted = [...entryTiers].sort((a, b) => a.entry_fee_cents - b.entry_fee_cents);
    subtitleParts.push(...sorted.map((t) => formatFee(t.entry_fee_cents)));
  } else {
    subtitleParts.push(entryFeeCents > 0 ? `${formatCents(entryFeeCents)} entry` : "Free entry");
  }
  const subtitle = subtitleParts.join(" · ");

  // Status pill
  const statusConfig = isOpen
    ? { label: "Open", cls: "bg-teal-500/90" }
    : isSettled
      ? { label: "Settled", cls: "bg-slate-500/90" }
      : { label: "Locked", cls: "bg-red-500/90" };

  return (
    <div className="relative w-full">
      <div className="relative h-48 md:h-56 lg:h-64 xl:h-72 overflow-hidden">
      {/* Background */}
      {bannerUrl ? (
        <img
          src={bannerUrl}
          alt={regattaName}
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
            const fallback = e.currentTarget.nextElementSibling as HTMLElement;
            if (fallback) fallback.style.display = "flex";
          }}
        />
      ) : null}
      <div
        className={`absolute inset-0 flex items-center justify-center ${bannerUrl ? "hidden" : ""}`}
        style={{ background: CARD_GRADIENTS[gradientIndex] }}
      >
        <span className="text-white/20 text-4xl lg:text-5xl font-bold text-center px-8 select-none">
          {regattaName}
        </span>
      </div>

      {/* Dark overlay for bottom text readability only */}
      <div className="absolute inset-0 z-[1] bg-gradient-to-t from-black/60 via-transparent to-transparent" />

      {/* Pill 1 — Back to Lobby (top-left) */}
      <button
        onClick={() => navigate("/lobby")}
        className="absolute top-3 left-3 md:top-4 md:left-4 z-10 bg-black/50 backdrop-blur-sm text-white text-xs md:text-sm font-medium px-3 py-1.5 md:px-4 md:py-2 rounded-full cursor-pointer hover:bg-black/70 transition-colors flex items-center gap-1.5 md:gap-2"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to Lobby
      </button>

      {/* Pill 2 — Status (top-right) */}
      <div
        className={`absolute top-3 right-3 md:top-4 md:right-4 z-10 ${statusConfig.cls} text-white text-xs md:text-sm font-semibold px-3 py-1.5 md:px-4 md:py-2 rounded-full`}
      >
        {statusConfig.label}
      </div>

      {/* Pill 3 — Countdown (bottom-left, above title) */}
      <div className="absolute bottom-[4.5rem] md:bottom-16 left-3 md:left-4 z-10 bg-black/60 backdrop-blur-sm text-white text-xs md:text-sm font-semibold px-3 py-1.5 rounded-full">
        {countdown}
      </div>

      {/* Title + Subtitle (bottom) */}
      <div className="absolute bottom-2 md:bottom-3 left-3 right-3 md:left-4 md:right-4 z-10">
        <h1 className="text-white text-xl md:text-2xl font-bold font-heading line-clamp-1">
          {regattaName}
        </h1>
        <p className="text-white/70 text-xs md:text-sm mt-0.5 line-clamp-1">
          {subtitle}
        </p>
      </div>
      </div>
    </div>
  );
};
