/**
 * Maps well-known rowing school/team names to their brand hex color.
 * Used for crew card theming — gradient backgrounds, borders, selection glow.
 */
export const SCHOOL_COLORS: Record<string, string> = {
  Harvard: "#A51C30",
  Yale: "#00356B",
  Princeton: "#EE7F2D",
  Columbia: "#75AADB",
  Penn: "#011F5B",
  Cornell: "#B31B1B",
  Brown: "#4E3629",
  Dartmouth: "#00693E",
  Navy: "#003B6F",
  Wisconsin: "#C5050C",
  Washington: "#4B2E83",
  Georgetown: "#041E42",
  MIT: "#A31F34",
  Stanford: "#8C1515",
  Cal: "#003262",
  Michigan: "#FFCB05",
  Northeastern: "#D41B2C",
  Syracuse: "#F76900",
  Virginia: "#232D4B",
  Clemson: "#F56600",
  Duke: "#003087",
  Texas: "#BF5700",
  "Notre Dame": "#0C2340",
  "Ohio State": "#BB0000",
  Florida: "#0021A5",
  "Boston University": "#CC0000",
  "Boston College": "#8B0000",
  Gonzaga: "#002967",
  "UC San Diego": "#182B49",
  "UC Davis": "#022851",
  "UC Santa Barbara": "#003660",
  Drexel: "#07294D",
  "George Washington": "#004065",
  Temple: "#9D2235",
  Villanova: "#003366",
  Colgate: "#821019",
  Bucknell: "#E87722",
  "Holy Cross": "#602D89",
  Lehigh: "#653819",
  "Loyola Maryland": "#006A4E",
  Marist: "#C8102E",
  "Saint Joseph's": "#9E1B34",
  "La Salle": "#003DA5",
  "Fordham": "#6D0026",
  "Stony Brook": "#990000",
  "Massachusetts": "#881C1C",
  "UMass": "#881C1C",
  "UConn": "#000E2F",
  "Delaware": "#00539F",
  "Creighton": "#005CA9",
  "Oklahoma": "#841617",
  "Indiana": "#990000",
  "Minnesota": "#7A0019",
  "Iowa": "#FFCD00",
  "Oregon State": "#DC4405",
  "USC": "#990000",
  "UCLA": "#2D68C4",
  "North Carolina": "#7BAFD4",
  "UNC": "#7BAFD4",
  "Kansas State": "#512888",
  "Tennessee": "#FF8200",
};

const DEFAULT_COLOR = "#1a2332";

/**
 * Returns the brand color hex for a crew name.
 * Matches if the crew name starts with or contains a known school key.
 */
export function getCrewColor(crewName: string): string {
  // Direct match first
  for (const [school, color] of Object.entries(SCHOOL_COLORS)) {
    if (crewName.startsWith(school) || crewName.includes(school)) {
      return color;
    }
  }
  return DEFAULT_COLOR;
}
