const bgStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  backgroundColor: '#f1f5f9',
  backgroundImage: `
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 22px,
      rgba(148,163,184,0.1) 22px, rgba(148,163,184,0.1) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 10px,
      rgba(255,255,255,0.5) 10px, rgba(255,255,255,0.5) 11px,
      transparent 11px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 22px,
      rgba(148,163,184,0.08) 22px, rgba(148,163,184,0.08) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 10px,
      rgba(255,255,255,0.4) 10px, rgba(255,255,255,0.4) 11px,
      transparent 11px, transparent 44px
    )
  `,
};

export const DraftPageBackground = () => (
  <div style={bgStyle} aria-hidden="true" />
);
