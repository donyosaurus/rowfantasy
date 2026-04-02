/**
 * Known country names for crew card design detection.
 * Country crews render with flag-as-background; university crews use color gradient.
 */
export const COUNTRY_NAMES = new Set([
  'USA', 'United States', 'Great Britain', 'Canada', 'Australia',
  'Germany', 'France', 'Italy', 'Spain', 'Netherlands', 'New Zealand',
  'Japan', 'China', 'South Africa', 'Brazil', 'Argentina', 'Mexico',
  'Ireland', 'Switzerland', 'Denmark', 'Norway', 'Sweden', 'Belgium',
  'Austria', 'Poland', 'Czech Republic', 'Romania', 'Greece', 'Portugal',
  'South Korea', 'India', 'Russia', 'Ukraine', 'Egypt', 'Chile',
  'Colombia', 'Peru', 'Cuba', 'Croatia', 'Serbia', 'Hungary',
  'Lithuania', 'Latvia', 'Estonia', 'Slovenia', 'Slovakia', 'Finland',
  'Israel', 'Turkey',
]);

export function isCountry(crewName: string): boolean {
  return COUNTRY_NAMES.has(crewName);
}
