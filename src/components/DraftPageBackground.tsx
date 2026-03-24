const bgStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
  backgroundImage: `
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.12) 22px, rgba(0,0,0,0.12) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.10) 22px, rgba(0,0,0,0.10) 23px,
      transparent 23px, transparent 44px
    )
  `,
};

export const DraftPageBackground = () => (
  <div style={bgStyle} aria-hidden="true" />
);
