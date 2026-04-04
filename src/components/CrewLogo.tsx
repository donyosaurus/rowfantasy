import { useState } from "react";
import { cn } from "@/lib/utils";
import { getCircleFlagUrl } from "@/data/countryFlags";

interface CrewLogoProps {
  logoUrl?: string | null;
  crewName: string;
  size?: number;
  className?: string;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function CrewLogo({ logoUrl, crewName, size = 48, className, ...rest }: CrewLogoProps & React.HTMLAttributes<HTMLDivElement>) {
  const [imgError, setImgError] = useState(false);

  // Prefer circle-flag SVG for countries, fall back to provided logoUrl
  const flagUrl = getCircleFlagUrl(crewName);
  const resolvedUrl = flagUrl || logoUrl;
  const showImage = resolvedUrl && !imgError;

  const isFlag = !!flagUrl;
  const innerSize = Math.round(size * 0.75);

  return (
    <div
      className={cn(
        "rounded-full overflow-hidden flex-shrink-0",
        isFlag
          ? "shadow-md ring-2 ring-white/30"
          : "flex items-center justify-center",
        !showImage && "bg-white text-foreground font-heading font-bold select-none flex items-center justify-center",
        className
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.35,
        ...(!isFlag && showImage
          ? {}
          : {}),
      }}
      {...rest}
    >
      {showImage ? (
        isFlag ? (
          <img
            src={resolvedUrl}
            alt={crewName}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <img
            src={resolvedUrl}
            alt={crewName}
            style={{ width: innerSize, height: innerSize }}
            className="object-contain"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        )
      ) : (
        <span>{getInitials(crewName)}</span>
      )}
    </div>
  );
}
