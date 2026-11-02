import type { ReactNode } from 'react';
import { CartProvider } from '@/cart/CartProvider';
import { AuthProvider } from '@/ui/AuthProvider';
import { Header } from '@/ui/Header';
import './globals.css';

export const metadata = { title: 'ChatPay Store' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <CartProvider>
            <Header />
            <main className="page">{children}</main>
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
