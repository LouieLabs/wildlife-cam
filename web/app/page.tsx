import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1>🦝 Louie Labs Wildlife Monitor</h1>
      <p>Backyard camera network control panel.</p>
      <ul style={{ lineHeight: 2 }}>
        <li><Link href="/dashboard">Live dashboard</Link></li>
        <li><Link href="/register">Register a new camera</Link></li>
        <li><Link href="/login">Sign in</Link></li>
      </ul>
    </main>
  );
}
