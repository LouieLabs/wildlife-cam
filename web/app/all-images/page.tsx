'use client';
import AppHeader from '@/components/AppHeader';
import CaptureGallery from '@/components/CaptureGallery';
import { useUser } from '@/lib/useUser';
import { ui } from '@/lib/ui';

// Every photo the cameras have uploaded, newest first — analyzed or not.
export default function AllImagesPage() {
  const { user, ready } = useUser();
  if (ready && !user) {
    return <main style={{ padding: 24 }}><p>Please <a href="/login">sign in</a> first.</p></main>;
  }
  return (
    <div style={{ minHeight: '100vh' }}>
      <AppHeader email={user?.email} active="/all-images" />
      <main style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>All images</h1>
        <p style={{ color: ui.slate, marginTop: 0 }}>
          Every photo your cameras have taken, newest first — including ones the AI hasn&apos;t looked at yet.
        </p>
        {user && <CaptureGallery mode="all" />}
      </main>
    </div>
  );
}
