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
    {/* SVG layers */}
    <svg
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 800 450"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Grid */}
        <pattern id="bg-grid" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
          <line x1="0" y1="40" x2="40" y2="40" stroke="rgba(148,163,184,0.035)" strokeWidth="0.5" />
          <line x1="40" y1="0" x2="40" y2="40" stroke="rgba(148,163,184,0.035)" strokeWidth="0.5" />
        </pattern>
        {/* Glows */}
        <radialGradient id="glow-blue" cx="0.75" cy="0.18" r="0.45">
          <stop offset="0%" stopColor="rgba(56,189,248,0.07)" />
          <stop offset="100%" stopColor="rgba(56,189,248,0)" />
        </radialGradient>
        <radialGradient id="glow-teal" cx="0.15" cy="0.85" r="0.4">
          <stop offset="0%" stopColor="rgba(20,184,166,0.06)" />
          <stop offset="100%" stopColor="rgba(20,184,166,0)" />
        </radialGradient>
        <radialGradient id="glow-indigo" cx="0.5" cy="0.5" r="0.35">
          <stop offset="0%" stopColor="rgba(99,102,241,0.035)" />
          <stop offset="100%" stopColor="rgba(99,102,241,0)" />
        </radialGradient>
      </defs>
      {/* Grid */}
      <rect width="800" height="450" fill="url(#bg-grid)" />
      {/* Glows */}
      <rect width="800" height="450" fill="url(#glow-blue)" />
      <rect width="800" height="450" fill="url(#glow-teal)" />
      <rect width="800" height="450" fill="url(#glow-indigo)" />
      {/* Diagonal band */}
      <line x1="0" y1="0" x2="800" y2="450" stroke="rgba(148,163,184,0.02)" strokeWidth="120" />
      {/* Star dots */}
      <circle cx="120" cy="80" r="1" fill="rgba(148,163,184,0.1)" />
      <circle cx="650" cy="60" r="1.5" fill="rgba(148,163,184,0.08)" />
      <circle cx="400" cy="200" r="1" fill="rgba(148,163,184,0.12)" />
      <circle cx="720" cy="350" r="1.5" fill="rgba(148,163,184,0.06)" />
      <circle cx="80" cy="380" r="1" fill="rgba(148,163,184,0.09)" />
      <circle cx="550" cy="120" r="2" fill="rgba(148,163,184,0.07)" />
    </svg>
  </div>
);
