const COLLEGE_ID_MAP: Record<string, number> = {
  "Harvard": 108, "Yale": 43, "Princeton": 163, "Brown": 225, "Cornell": 172,
  "Penn": 219, "Columbia": 171, "Dartmouth": 159, "Washington": 264, "California": 25,
  "Stanford": 24, "Wisconsin": 275, "Michigan": 130, "Syracuse": 183, "Georgetown": 46,
  "Navy": 2426, "Northeastern": 111, "Boston University": 104, "Virginia": 258,
  "Clemson": 228, "Notre Dame": 87, "Texas": 251, "Ohio State": 194, "Gonzaga": 2250,
  "Villanova": 222, "Drexel": 2182, "Temple": 218, "Tulsa": 202, "MIT": 109,
  "Duke": 150, "North Carolina": 153, "Minnesota": 135, "Indiana": 84,
  "Oregon State": 204, "USC": 30, "UCLA": 26, "Rutgers": 164, "Bucknell": 2083,
  "Colgate": 2142, "George Washington": 45, "Lehigh": 2329, "Holy Cross": 107,
  "Loyola Maryland": 2352, "Marist": 2368, "Mercyhurst": 2382, "Oklahoma": 201,
  "Tennessee": 2633, "Creighton": 156, "San Diego": 301, "Alabama": 333, "LSU": 99,
  "Florida": 57, "Iowa": 2294, "Kansas State": 2306, "Purdue": 2509, "Louisville": 97,
  "Drake": 2181, "Rhode Island": 227, "Connecticut": 41, "Massachusetts": 113,
  "New Hampshire": 160, "Vermont": 261,
};

export function getCollegeLogoUrl(crewName: string): string | null {
  const id = COLLEGE_ID_MAP[crewName];
  if (!id) return null;
  return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/${id}.png&h=80&w=80`;
}
