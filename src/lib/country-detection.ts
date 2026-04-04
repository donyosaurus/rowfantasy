import { isCountryName } from "@/data/countryFlags";

/**
 * Known country names for crew card design detection.
 * Country crews render with flag-as-background; university crews use color gradient.
 */
export function isCountry(crewName: string): boolean {
  return isCountryName(crewName);
}
