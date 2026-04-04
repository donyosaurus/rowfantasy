import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { getCrewColor, isLightColor } from "@/lib/school-colors";
import { isCountry } from "@/lib/country-detection";

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
  const color = getCrewColor(crewName);
  const light = isLightColor(color);
  const textColor = light ? "text-slate-900" : "text-white";
  const subtextColor = light ? "text-slate-600" : "text-white/70";
  const country = isCountry(crewName);

  return (
    <div
      className={`
        flex items-center gap-4 px-4 py-3 rounded-xl transition-all border-2
        ${!isOpen ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}
        ${isSelected
          ? "border-teal-400 shadow-lg shadow-teal-400/20 scale-[1.01]"
          : "border-transparent hover:border-white/20 hover:scale-[1.005]"
        }
      `}
      style={{
        background: `linear-gradient(135deg, ${color} 0%, ${color}${country ? "dd" : "cc"} 100%)`,
        animation: `fadeUp 0.4s ease forwards`,
        animationDelay: `${animDelay}ms`,
        opacity: 0,
      }}
      onClick={() => isOpen && onToggle(crewId)}
    >
      {/* Logo circle */}
      <CrewLogo
        logoUrl={logoUrl}
        crewName={crewName}
        size={48}
      />

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className={`text-base font-bold truncate ${textColor}`}>{crewName}</p>
        <p className={`text-xs font-semibold uppercase tracking-wider ${subtextColor}`}>{eventId}</p>
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
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/20 border border-white/20">
            <Input
              type="number"
              min="0.01"
              step="0.1"
              placeholder="Margin"
              className="h-6 w-16 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 placeholder:text-white/40"
              style={{ color: light ? "#1e293b" : "white" }}
              value={marginVal || ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                onMarginChange(crewId, parseFloat(e.target.value) || 0);
              }}
            />
            <span className={`text-[10px] whitespace-nowrap ${subtextColor}`}>sec</span>
          </div>
        </div>
      )}
    </div>
  );
}
