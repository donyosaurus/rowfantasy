const bgStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  backgroundColor: '#0f1a2e',
  backgroundImage: `
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.35) 22px, rgba(0,0,0,0.35) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 10px,
      rgba(100,160,220,0.06) 10px, rgba(100,160,220,0.06) 11px,
      transparent 11px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.3) 22px, rgba(0,0,0,0.3) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 10px,
      rgba(100,160,220,0.05) 10px, rgba(100,160,220,0.05) 11px,
      transparent 11px, transparent 44px
    ),
    radial-gradient(ellipse at 30% 20%, rgba(30,58,95,0.3) 0%, transparent 60%),
    radial-gradient(ellipse at 70% 80%, rgba(20,50,90,0.2) 0%, transparent 60%)
  `,
};

export const DraftPageBackground = () => (
  <div style={bgStyle} aria-hidden="true" />
);
