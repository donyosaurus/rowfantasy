import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a duration expressed in seconds as `M:SS.cc`.
 * e.g. 754.32 -> "12:34.32"
 */
export function formatSecondsAsTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "-" : "";
  const cs = Math.round(Math.abs(seconds) * 100);
  const mins = Math.floor(cs / 6000);
  const secs = (cs % 6000) / 100;
  return `${sign}${mins}:${secs.toFixed(2).padStart(5, "0")}`;
}

