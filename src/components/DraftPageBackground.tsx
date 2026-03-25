const bgStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  backgroundColor: '#162033',
  backgroundImage: `
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.2) 22px, rgba(0,0,0,0.2) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 10px,
      rgba(100,160,220,0.04) 10px, rgba(100,160,220,0.04) 11px,
      transparent 11px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.18) 22px, rgba(0,0,0,0.18) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 10px,
      rgba(100,160,220,0.035) 10px, rgba(100,160,220,0.035) 11px,
      transparent 11px, transparent 44px
    )
  `,
};

export const DraftPageBackground = () => (
  <div style={bgStyle} aria-hidden="true" />
);
