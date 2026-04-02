import { CrewLogo } from "@/components/CrewLogo";
import { Input } from "@/components/ui/input";
import { getCrewColor } from "@/lib/school-colors";
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
  const country = isCountry(crewName);
  const color = getCrewColor(crewName);

  const wrapperClasses = `relative rounded-xl overflow-hidden transition-all duration-300 w-full ${
    !isOpen
      ? "opacity-60 cursor-not-allowed"
      : "cursor-pointer hover:scale-[1.01] hover:brightness-105"
  } ${
    isSelected
      ? "border-2 border-teal-400 scale-[1.02] shadow-lg shadow-teal-400/20"
      : "border-2 border-transparent"
  }`;

  const selectedBadge = isSelected && (
    <div className="absolute top-1.5 right-2 w-6 h-6 rounded-full z-10 flex items-center justify-center bg-teal-400">
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
  );

  const marginInput = isSelected && isOpen && (
    <div className="mt-2 animate-fade-in" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5 p-1.5 rounded-md bg-slate-100 border border-slate-200">
        <Input
          type="number"
          min="0.01"
          step="0.1"
          placeholder="Margin"
          className="h-6 text-xs border-0 bg-transparent p-0 focus-visible:ring-0 placeholder:text-slate-400 text-slate-900"
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
  );

  if (country) {
    return (
      <div
        className={wrapperClasses}
        style={{
          animation: `fadeUp 0.4s ease forwards`,
          animationDelay: `${animDelay}ms`,
          opacity: 0,
        }}
        onClick={() => isOpen && onToggle(crewId)}
      >
        {selectedBadge}

        {/* Flag fills top section as background banner */}
        <div className="relative h-36 overflow-hidden bg-slate-200">
          {logoUrl ? (
            <img
              src={logoUrl}
              className="absolute inset-0 w-full h-full object-cover"
              alt={crewName}
              loading="lazy"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-3xl font-bold text-slate-400">
              {crewName.slice(0, 2).toUpperCase()}
            </div>
          )}
          {/* Subtle gradient for visual separation */}
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/30 to-transparent" />
        </div>

        {/* White bottom section */}
        <div className="bg-white px-3 pb-3 pt-2 text-center">
          <p className="text-slate-900 text-lg font-bold truncate">{crewName}</p>
          <p className="text-slate-500 text-xs font-semibold uppercase tracking-wider mt-1">
            {eventId}
          </p>
          {marginInput}
        </div>
      </div>
    );
  }

  // University card — school color gradient to white
  return (
    <div
      className={wrapperClasses}
      style={{
        animation: `fadeUp 0.4s ease forwards`,
        animationDelay: `${animDelay}ms`,
        opacity: 0,
      }}
      onClick={() => isOpen && onToggle(crewId)}
    >
      {selectedBadge}

      {/* Colored section — gradient fade to white */}
      <div
        className="relative pt-8 pb-6 flex items-center justify-center"
        style={{
          background: `linear-gradient(to bottom, ${color} 0%, ${color} 50%, white 100%)`,
        }}
      >
        <div className="w-20 h-20 rounded-full overflow-hidden bg-white shadow-md ring-2 ring-white/50">
          <CrewLogo
            logoUrl={logoUrl}
            crewName={crewName}
            size={80}
            className="rounded-full object-contain p-1"
          />
        </div>
      </div>

      {/* White section — name and event */}
      <div className="bg-white px-3 pb-3 pt-2 text-center">
        <p className="text-slate-900 text-lg font-bold truncate">{crewName}</p>
        <p
          className="text-xs font-semibold uppercase tracking-wider mt-1"
          style={{ color }}
        >
          {eventId}
        </p>
        {marginInput}
      </div>
    </div>
  );
}
