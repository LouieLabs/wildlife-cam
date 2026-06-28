'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

// Small auth widget for the main page: shows a Sign in link when logged out, or
// who's signed in plus a Sign out button when logged in.
export default function AuthControl() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => onAuthStateChanged(clientAuth, setUser), []);

  if (!user) {
    return <p><a href="/login">Sign in</a></p>;
  }
  return (
    <p>
      Signed in as <b>{user.email}</b>{' '}
      <button onClick={() => signOut(clientAuth)} style={{ marginLeft: 8 }}>
        Sign out
      </button>
    </p>
  );
}
