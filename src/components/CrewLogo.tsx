import { useState } from "react";
import { cn } from "@/lib/utils";

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

  const showImage = logoUrl && !imgError;
  const containerSize = Math.round(size * 1.18);

  return (
    <div
      className={cn(
        "rounded-full flex items-center justify-center overflow-hidden flex-shrink-0 bg-white text-foreground font-heading font-bold select-none",
        className
      )}
      style={{ width: containerSize, height: containerSize, fontSize: size * 0.35 }}
      {...rest}
    >
      {showImage ? (
        <img
          src={logoUrl}
          alt={crewName}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
          loading="lazy"
        />
      ) : (
        <span>{getInitials(crewName)}</span>
      )}
    </div>
  );
}
