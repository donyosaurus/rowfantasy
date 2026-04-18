import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { getCrewPalette, getStripeBackground } from "@/lib/crew-theme";

interface CrewCardProps {
  crewId: string;
  crewName: string;
  eventId: string;
  logoUrl?: string | null;
  isSelected: boolean;
  marginVal: number;
  isOpen: boolean;
  onToggle: (crewId: string) => void;
  onMarginChange: (crewId: string, margin: number) => void;
  animDelay?: number;
}

export function CrewCard({
  crewId, crewName, eventId, logoUrl, isSelected, marginVal,
  isOpen, onToggle, onMarginChange, animDelay = 0,
}: CrewCardProps) {
  const palette = getCrewPalette(crewName);
  const stripeBg = getStripeBackground(palette);

  return (
    <div
      className={`
        relative flex items-center gap-4 pl-5 pr-4 py-3 rounded-xl transition-all ring-2 overflow-hidden
        bg-white
        ${!isOpen ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}
        ${isSelected
          ? "ring-teal-400 shadow-lg shadow-teal-400/20 scale-[1.01]"
          : "ring-transparent hover:ring-slate-200 hover:bg-slate-50 hover:scale-[1.005]"
        }
      `}
      style={{
        animation: `fadeUp 0.4s ease forwards`,
        animationDelay: `${animDelay}ms`,
        opacity: 0,
      }}
      onClick={() => isOpen && onToggle(crewId)}
    >
      {/* Left-edge flag accent stripe */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5"
        style={{ background: stripeBg }}
        aria-hidden="true"
      />

      {/* Logo circle */}
      <CrewLogo
        logoUrl={logoUrl}
        crewName={crewName}
        size={48}
      />

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className="text-base font-bold truncate text-slate-900">{crewName}</p>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{eventId}</p>
      </div>

      {/* Selected checkmark */}
      {isSelected && (
        <div className="w-6 h-6 rounded-full bg-teal-400 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      {/* Margin input when selected */}
      {isSelected && isOpen && (
        <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 border border-slate-200">
            <Input
              type="number"
              min="0.01"
              step="0.1"
              placeholder="Margin"
              className="h-6 w-16 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 placeholder:text-slate-400 text-slate-900"
              value={marginVal || ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                onMarginChange(crewId, parseFloat(e.target.value) || 0);
              }}
            />
            <span className="text-[10px] whitespace-nowrap text-slate-500">sec</span>
          </div>
        </div>
      )}
    </div>
  );
}
