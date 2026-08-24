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
  const abs = Math.abs(seconds);
  const mins = Math.floor(abs / 60);
  const secs = abs - mins * 60;
  return `${sign}${mins}:${secs.toFixed(2).padStart(5, "0")}`;
}
