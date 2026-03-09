import { useState, useEffect, useCallback } from "react";
import stateStatuses from "@/data/stateStatuses.json";

const STATUS_COLORS: Record<string, string> = {
  permitted: "#86efac",
  restricted: "#fcd34d",
  banned: "#d1d5db",
};

const STATUS_LABELS: Record<string, string> = {
  permitted: "Permitted",
  restricted: "Restricted",
  banned: "Banned",
};

const FIPS_TO_ABBR: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
  "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
  "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
  "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
  "55": "WI", "56": "WY",
};

const FIPS_TO_NAME: Record<string, string> = {
  "01": "Alabama", "02": "Alaska", "04": "Arizona", "05": "Arkansas", "06": "California",
  "08": "Colorado", "09": "Connecticut", "10": "Delaware", "11": "District of Columbia",
  "12": "Florida", "13": "Georgia", "15": "Hawaii", "16": "Idaho", "17": "Illinois",
  "18": "Indiana", "19": "Iowa", "20": "Kansas", "21": "Kentucky", "22": "Louisiana",
  "23": "Maine", "24": "Maryland", "25": "Massachusetts", "26": "Michigan", "27": "Minnesota",
  "28": "Mississippi", "29": "Missouri", "30": "Montana", "31": "Nebraska", "32": "Nevada",
  "33": "New Hampshire", "34": "New Jersey", "35": "New Mexico", "36": "New York",
  "37": "North Carolina", "38": "North Dakota", "39": "Ohio", "40": "Oklahoma", "41": "Oregon",
  "42": "Pennsylvania", "44": "Rhode Island", "45": "South Carolina", "46": "South Dakota",
  "47": "Tennessee", "48": "Texas", "49": "Utah", "50": "Vermont", "51": "Virginia",
  "53": "Washington", "54": "West Virginia", "55": "Wisconsin", "56": "Wyoming",
};

interface GeoFeature {
  type: string;
  id: string;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: number[][][] | number[][][][];
  };
}

function topoToGeo(topology: any): GeoFeature[] {
  const obj = topology.objects.states;
  const arcs = topology.arcs;
  const transform = topology.transform;

  function decodeArc(arcIndex: number): number[][] {
    const isReversed = arcIndex < 0;
    const idx = isReversed ? ~arcIndex : arcIndex;
    const arc = arcs[idx];
    const coords: number[][] = [];
    let x = 0, y = 0;
    for (const [dx, dy] of arc) {
      x += dx;
      y += dy;
      const lon = transform ? x * transform.scale[0] + transform.translate[0] : x;
      const lat = transform ? y * transform.scale[1] + transform.translate[1] : y;
      coords.push([lon, lat]);
    }
    if (isReversed) coords.reverse();
    return coords;
  }

  function decodeRing(ring: number[]): number[][] {
    const coords: number[][] = [];
    for (const arcIdx of ring) {
      const decoded = decodeArc(arcIdx);
      const start = coords.length > 0 ? 1 : 0;
      for (let i = start; i < decoded.length; i++) {
        coords.push(decoded[i]);
      }
    }
    return coords;
  }

  if (obj.type === "GeometryCollection") {
    return obj.geometries.map((geom: any) => {
      let coordinates: number[][][] | number[][][][] = [];
      if (geom.type === "Polygon") {
        coordinates = geom.arcs.map((ring: number[]) => decodeRing(ring));
      } else if (geom.type === "MultiPolygon") {
        coordinates = geom.arcs.map((polygon: number[][]) =>
          polygon.map((ring: number[]) => decodeRing(ring))
        );
      }
      return {
        type: "Feature",
        id: geom.id,
        properties: geom.properties || {},
        geometry: { type: geom.type, coordinates },
      };
    });
  }
  return [];
}

// Project continental US
function projectLower48(lon: number, lat: number): [number, number] {
  const scale = 1100;
  const centerLon = -96;
  const centerLat = 38.5;
  const x = (lon - centerLon) * (Math.PI / 180) * scale * Math.cos(centerLat * Math.PI / 180);
  const y = -(lat - centerLat) * (Math.PI / 180) * scale;
  return [x + 480, y + 300];
}

// Project Alaska (scaled down and repositioned)
function projectAlaska(lon: number, lat: number): [number, number] {
  const scale = 400;
  const centerLon = -154;
  const centerLat = 64;
  const x = (lon - centerLon) * (Math.PI / 180) * scale * Math.cos(centerLat * Math.PI / 180);
  const y = -(lat - centerLat) * (Math.PI / 180) * scale;
  return [x + 120, y + 490];
}

// Project Hawaii (repositioned)
function projectHawaii(lon: number, lat: number): [number, number] {
  const scale = 1100;
  const centerLon = -157;
  const centerLat = 20.5;
  const x = (lon - centerLon) * (Math.PI / 180) * scale * Math.cos(centerLat * Math.PI / 180);
  const y = -(lat - centerLat) * (Math.PI / 180) * scale;
  return [x + 280, y + 490];
}

function projectPoint(lon: number, lat: number, fips: string): [number, number] {
  if (fips === "02") return projectAlaska(lon, lat);
  if (fips === "15") return projectHawaii(lon, lat);
  return projectLower48(lon, lat);
}

function projectCoords(coords: number[][], fips: string): string {
  return coords
    .map(([lon, lat]) => {
      const [x, y] = projectPoint(lon, lat, fips);
      return `${x},${y}`;
    })
    .join(" ");
}

export const StateAvailabilityMap = () => {
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [hoveredState, setHoveredState] = useState<string | null>(null);
  const [copiedState, setCopiedState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json")
      .then((r) => r.json())
      .then((topo) => {
        setFeatures(topoToGeo(topo));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const getStatus = (fips: string): string =>
    (stateStatuses as Record<string, string>)[FIPS_TO_ABBR[fips] || ""] || "banned";

  const handleClick = useCallback((fips: string) => {
    const abbr = FIPS_TO_ABBR[fips] || "";
    const name = FIPS_TO_NAME[fips] || "Unknown";
    const status = getStatus(fips);
    navigator.clipboard.writeText(`${name} (${abbr}): ${STATUS_LABELS[status] || status}`);
    setCopiedState(fips);
    setTimeout(() => setCopiedState(null), 1500);
  }, []);

  const svgWidth = 960;
  const svgHeight = 600;

  return (
    <div className="w-full max-w-4xl mx-auto">
      {loading ? (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading map…
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-auto"
            xmlns="http://www.w3.org/2000/svg"
          >
            {features.map((feature) => {
              const fips = String(feature.id).padStart(2, "0");
              const status = getStatus(fips);
              const fill = STATUS_COLORS[status] || STATUS_COLORS.banned;
              const isHovered = hoveredState === fips;
              const geom = feature.geometry;

              const polygons: number[][][][] =
                geom.type === "Polygon"
                  ? [geom.coordinates as number[][][]]
                  : (geom.coordinates as number[][][][]);

              return (
                <g
                  key={fips}
                  onMouseEnter={() => setHoveredState(fips)}
                  onMouseLeave={() => setHoveredState(null)}
                  onClick={() => handleClick(fips)}
                  style={{ cursor: "pointer" }}
                >
                  {polygons.map((polygon, pi) =>
                    polygon.map((ring, ri) => (
                      <polygon
                        key={`${fips}-${pi}-${ri}`}
                        points={projectCoords(ring, fips)}
                        fill={fill}
                        stroke="#fff"
                        strokeWidth={isHovered ? 2 : 0.5}
                        opacity={hoveredState && !isHovered ? 0.6 : 1}
                        style={{ transition: "opacity 0.15s, stroke-width 0.15s" }}
                      />
                    ))
                  )}
                </g>
              );
            })}
          </svg>

          {hoveredState && (
            <div className="absolute top-4 left-4 bg-card border border-border rounded-lg px-4 py-2 shadow-lg pointer-events-none">
              <p className="font-semibold text-sm">{FIPS_TO_NAME[hoveredState] || "Unknown"}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {getStatus(hoveredState)}
              </p>
            </div>
          )}

          {copiedState && (
            <div className="absolute top-4 right-4 bg-card border border-border rounded-lg px-4 py-2 shadow-lg pointer-events-none text-sm text-muted-foreground">
              Copied!
            </div>
          )}
        </div>
      )}

      <div className="flex justify-center gap-6 mt-6 flex-wrap">
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded"
              style={{ backgroundColor: STATUS_COLORS[key] }}
            />
            <span className="text-sm font-medium">{label}</span>
          </div>
        ))}
      </div>

      <p className="text-center text-sm text-muted-foreground mt-3">
        Click any state to copy its status to clipboard
      </p>

      <p className="text-center text-xs text-muted-foreground mt-6 italic">
        The use of VPNs to bypass geofencing regulations is unethical and heavily discouraged.
      </p>
    </div>
  );
};
