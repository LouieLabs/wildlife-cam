import type { CSSProperties } from 'react';

// Shared UI tokens so the dashboard, the image pages, and the app header all
// read as one design. (The dashboard keeps its own copy of these for its camera
// cards; this module is what the newer shared components import.)
export const ui = {
  green: '#15803d',
  greenLight: '#16a34a',
  slate: '#475569',
  border: '#e2e8f0',
  cardBg: '#ffffff',
  danger: '#b91c1c',
} as const;

export const card: CSSProperties = {
  padding: 16,
  background: ui.cardBg,
  border: `1px solid ${ui.border}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
};

export const btnGhost: CSSProperties = {
  background: '#fff', color: ui.slate, border: `1px solid ${ui.border}`,
  borderRadius: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer',
};
