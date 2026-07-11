'use client';
import AppHeader from '@/components/AppHeader';
import CaptureGallery from '@/components/CaptureGallery';
import { useUser } from '@/lib/useUser';
import { ui } from '@/lib/ui';

// Only the photos the AI has analyzed AND found an animal or a person in.
export default function DetectionsPage() {
  const { user, ready } = useUser();
  if (ready && !user) {
    return <main style={{ padding: 24 }}><p>Please <a href="/login">sign in</a> first.</p></main>;
  }
  return (
    <div style={{ minHeight: '100vh' }}>
      <AppHeader email={user?.email} active="/detections" />
      <main style={{ maxWidth: 860, margin: '0 auto', padding: 24 }}>
        <h1 style={{ fontSize: 24, margin: '4px 0 2px' }}>Detections</h1>
        <p style={{ color: ui.slate, marginTop: 0 }}>
          Photos the AI analyzed and found an animal or a person in. See every photo on the{' '}
          <a href="/all-images" style={{ color: ui.green }}>All images</a> page.
        </p>
        {user && <CaptureGallery mode="detections" />}
      </main>
    </div>
  );
}
