'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { clientAuth, googleProvider } from '@/lib/firebaseClient';

const DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN || 'louielabs.com';

export default function LoginPage() {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  async function handleSignIn() {
    setError('');
    try {
      const cred = await signInWithPopup(clientAuth, googleProvider);
      const email = (cred.user.email || '').toLowerCase();
      if (!email.endsWith('@' + DOMAIN)) {
        await signOut(clientAuth);
        setError(`Please use your @${DOMAIN} account.`);
      } else {
        router.push('/'); // signed in -> back to the main page
      }
    } catch (e: any) {
      setError(e?.message || 'Sign-in failed');
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <h1>Sign in</h1>
      {user ? (
        <>
          <p>Signed in as <b>{user.email}</b></p>
          <button onClick={() => signOut(clientAuth)}>Sign out</button>
        </>
      ) : (
        <button onClick={handleSignIn}>Sign in with your Louie Labs Google account</button>
      )}
      {error && <p style={{ color: '#f87171' }}>{error}</p>}
    </main>
  );
}
