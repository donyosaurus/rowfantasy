import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { getCrewColor } from "@/lib/school-colors";

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

  return (
    <div
      className={`relative rounded-[14px] overflow-hidden bg-white transition-all duration-300 border w-full h-[255px] ${
        !isOpen
          ? "opacity-60 cursor-not-allowed"
          : "cursor-pointer hover:-translate-y-1.5 hover:shadow-xl"
      }`}
      style={{
        border: isSelected
          ? `2px solid ${color}`
          : `1.5px solid rgba(255,255,255,0.2)`,
        boxShadow: isSelected
          ? `0 0 0 3px ${color}25, 0 10px 30px rgba(0,0,0,0.15)`
          : `0 4px 20px rgba(0,0,0,0.12)`,
        animation: `fadeUp 0.4s ease forwards`,
        animationDelay: `${animDelay}ms`,
        opacity: 0,
      }}
      onClick={() => isOpen && onToggle(crewId)}
    >
      {/* Layer 1 — Color fade — vibrant */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{
          height: 120,
          background: `linear-gradient(180deg, ${color} 0%, ${color}ee 50%, transparent 100%)`,
        }}
      />

      {/* Selected checkmark badge */}
      {isSelected && (
        <div
          className="absolute top-1.5 right-2 w-6 h-6 rounded-full z-10 flex items-center justify-center"
          style={{ background: color }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2.5 7.5L5.5 10.5L11.5 4"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}

      {/* Layer 2 — Logo circle */}
      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-full bg-white flex items-center justify-center z-[5]"
        style={{
          top: 55,
          width: 78,
          height: 78,
          border: "2.5px solid rgba(255,255,255,0.5)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        }}
      >
        <CrewLogo
          logoUrl={logoUrl}
          crewName={crewName}
          size={44}
          className="rounded-full"
        />
      </div>

      {/* Layer 3 — Text & margin input */}
      <div
        className="absolute bottom-0 left-0 right-0 text-center"
        style={{ padding: "10px 14px 16px" }}
      >
        <p className="font-semibold text-[15px] text-slate-900 tracking-tight leading-tight">
          {crewName}
        </p>
        <p
          className="text-[11px] font-medium mt-[3px] tracking-wider uppercase"
          style={{ color }}
        >
          {eventId}
        </p>

        {isSelected && isOpen && (
          <div className="mt-2 animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5 p-1.5 rounded-md bg-slate-100 border border-slate-200">
              <Input
                type="number"
                min="0.01"
                step="0.1"
                placeholder="Margin"
                className="h-6 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 text-slate-900 placeholder:text-slate-400"
                value={marginVal || ""}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  onMarginChange(crewId, parseFloat(e.target.value) || 0);
                }}
              />
              <span className="text-[10px] text-slate-500 whitespace-nowrap">sec</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
