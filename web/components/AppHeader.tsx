'use client';
import Link from 'next/link';
import { signOut } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';
import { ui } from '@/lib/ui';

// Sticky green app bar shared by the dashboard and the image pages. `active`
// is the href of the current page so its nav link reads as selected.
const NAV: { href: string; label: string }[] = [
  { href: '/dashboard', label: 'Cameras' },
  { href: '/all-images', label: 'All images' },
  { href: '/detections', label: 'Detections' },
  { href: '/provision', label: 'Set up a camera' },
  { href: '/networks', label: 'Wi-Fi networks' },
];

export default function AppHeader({ email, active }: { email?: string | null; active?: string }) {
  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        padding: '12px 24px', color: '#fff',
        background: `linear-gradient(90deg, ${ui.green} 0%, ${ui.greenLight} 100%)`,
        boxShadow: '0 2px 10px rgba(21,128,61,0.28)',
      }}
    >
      <Link
        href="/"
        style={{ color: '#fff', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 17 }}
      >
        🦝 Wildlife Monitor
      </Link>
      <nav style={{ display: 'flex', gap: 14, fontSize: 14, flexWrap: 'wrap' }}>
        {NAV.map((n) => {
          const on = active === n.href;
          return (
            <Link
              key={n.href}
              href={n.href}
              style={{
                color: '#fff',
                textDecoration: 'none',
                opacity: on ? 1 : 0.85,
                fontWeight: on ? 700 : 500,
                borderBottom: on ? '2px solid #fff' : '2px solid transparent',
                paddingBottom: 2,
              }}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        {email && <span style={{ opacity: 0.9 }}>{email}</span>}
        <button
          onClick={() => signOut(clientAuth)}
          style={{
            background: 'rgba(255,255,255,0.16)', color: '#fff',
            border: '1px solid rgba(255,255,255,0.45)', borderRadius: 8,
            padding: '6px 10px', fontSize: 13, cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </span>
    </header>
  );
}
