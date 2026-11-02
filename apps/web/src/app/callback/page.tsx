'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { userManager } from '@/core/auth';

export default function Callback() {
  const router = useRouter();
  const started = useRef(false);   // React strict mode runs effects twice; the auth code is single-use
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    userManager()
      .signinRedirectCallback()
      .then(() => router.replace('/'))
      .catch((e: Error) => setError(e.message));
  }, [router]);

  return <p className="center">{error ? `Login failed: ${error}` : 'Signing you in…'}</p>;
}
