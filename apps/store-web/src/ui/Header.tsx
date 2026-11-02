'use client';
import Link from 'next/link';
import { useCart } from '@/cart/CartProvider';
import { config } from '@/core/config';
import { useAuth } from './AuthProvider';

export function Header() {
  const { count } = useCart();
  const { user, ready, login, logout } = useAuth();
  return (
    <header className="site-header">
      <Link href="/" className="brand">ChatPay Store</Link>
      <nav>
        <Link href="/products">Products</Link>
        <Link href="/cart">Cart{count > 0 && <span className="badge">{count}</span>}</Link>
        {user && <Link href="/orders">My orders</Link>}
        <Link href="/sell">Sell</Link>
        <a href={config.chatUrl} target="_blank" rel="noreferrer">Chat</a>
      </nav>
      <div className="auth">
        {ready && (user
          ? <><span>{user.profile.name ?? user.profile.preferred_username}</span><button onClick={logout}>Sign out</button></>
          : <button className="primary" onClick={login}>Sign in</button>)}
      </div>
    </header>
  );
}
