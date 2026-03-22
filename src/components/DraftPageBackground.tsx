export const DraftPageBackground = () => (
  <div className="fixed inset-0 z-0 pointer-events-none" aria-hidden="true">
    {/* Base gradient */}
    <div
      className="absolute inset-0"
      style={{
        background:
          "linear-gradient(160deg, #080d1a 0%, #0e1629 30%, #131d35 55%, #0f172a 100%)",
      }}
    />
    {/* Diamond tile pattern */}
    <svg
      className="absolute inset-0 w-full h-full"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern
          id="diamond-tiles"
          x="0"
          y="0"
          width="48"
          height="48"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          {/* Each "tile" is a rounded rect with a gap */}
          <rect
            x="1.5"
            y="1.5"
            width="45"
            height="45"
            rx="3"
            ry="3"
            fill="rgba(148,163,184,0.025)"
            stroke="rgba(148,163,184,0.06)"
            strokeWidth="0.5"
          />
        </pattern>
        {/* Subtle center vignette */}
        <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0%" stopColor="rgba(148,163,184,0.03)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#diamond-tiles)" />
      <rect width="100%" height="100%" fill="url(#vignette)" />
    </svg>
  </div>
);
