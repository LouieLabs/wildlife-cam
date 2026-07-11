'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clientAuth } from '@/lib/firebaseClient';

// Subscribe to Firebase auth state. `ready` flips true once the first auth
// callback has fired, so pages can tell "still checking" apart from "signed
// out" and avoid flashing a sign-in prompt on load.
export function useUser(): { user: User | null; ready: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => onAuthStateChanged(clientAuth, (u) => { setUser(u); setReady(true); }), []);
  return { user, ready };
}
