'use client';
import { AuthGate } from '@/ui/AuthGate';
import { ChatApp } from '@/ui/ChatApp';

export default function Home() {
  return <AuthGate>{(user) => <ChatApp user={user} />}</AuthGate>;
}
