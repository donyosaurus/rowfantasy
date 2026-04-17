import { SCHOOL_COLORS } from "./school-colors";
import { COUNTRY_FLAG_COLORS } from "./country-colors";
import { isCountry } from "./country-detection";

/**
 * Returns the ordered color palette used to render a crew's accent stripe.
 * Countries return their flag colors; schools return a single brand color;
 * unknown crews fall back to a neutral gray.
 */
export function getCrewPalette(crewName: string): string[] {
  if (isCountry(crewName) && COUNTRY_FLAG_COLORS[crewName]) {
    return COUNTRY_FLAG_COLORS[crewName];
  }
  for (const [school, color] of Object.entries(SCHOOL_COLORS)) {
    if (crewName.startsWith(school) || crewName.includes(school)) {
      return [color];
    }
  }
  return ["#475569"];
}

/**
 * Returns a CSS background value for the left-edge accent stripe.
 * Single-color palettes render as a flat fill; multi-color palettes render
 * as a vertical linear gradient with equal-sized stops.
 */
export function getStripeBackground(palette: string[]): string {
  if (palette.length === 1) return palette[0];
  const stops: string[] = [];
  palette.forEach((color, i) => {
    const start = (i / palette.length) * 100;
    const end = ((i + 1) / palette.length) * 100;
    stops.push(`${color} ${start}% ${end}%`);
  });
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}
