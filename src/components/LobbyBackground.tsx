const bgStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 0,
  pointerEvents: 'none',
  backgroundImage: `
    repeating-linear-gradient(
      135deg,
      transparent 0px, transparent 22px,
      rgba(0,0,0,0.08) 22px, rgba(0,0,0,0.08) 23px,
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
      rgba(0,0,0,0.07) 22px, rgba(0,0,0,0.07) 23px,
      transparent 23px, transparent 44px
    ),
    repeating-linear-gradient(
      45deg,
      transparent 0px, transparent 10px,
      rgba(100,160,220,0.03) 10px, rgba(100,160,220,0.03) 11px,
      transparent 11px, transparent 44px
    )
  `,
};

export const LobbyBackground = () => (
  <div style={bgStyle} aria-hidden="true" />
);
