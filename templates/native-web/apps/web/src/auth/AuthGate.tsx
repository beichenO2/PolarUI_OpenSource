import { useEffect, useState } from 'react';
import { App, type PublicProductManifest } from '../App';
import { getSession, logout, type SessionUser } from './api';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { VerifyEmailPage } from './VerifyEmailPage';
import { setReturnPath, takeReturnPath } from './storage';

export function AuthGate({ manifest }: { manifest: PublicProductManifest }) {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [path, setPath] = useState(window.location.pathname);
  const [verificationEmail, setVerificationEmail] = useState('');
  const navigate = (next: string) => { history.pushState({}, '', next); setPath(next); };

  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    addEventListener('popstate', listener);
    getSession().then((result) => setUser(result.user)).catch(() => {
      if (!['/login', '/register', '/verify-email'].includes(window.location.pathname)) {
        setReturnPath(manifest.product.id, window.location.pathname + window.location.search);
      }
      setUser(null);
    });
    return () => removeEventListener('popstate', listener);
  }, []);

  if (user === undefined) return <main className="auth-page"><p>正在载入工作区…</p></main>;
  if (!user) {
    if (path === '/register') return <RegisterPage onNavigate={navigate} onRegistered={(email) => {
      setVerificationEmail(email); navigate('/verify-email');
    }} />;
    if (path === '/verify-email' && verificationEmail) {
      return <VerifyEmailPage email={verificationEmail} onVerified={() => navigate('/login')} />;
    }
    return <LoginPage onNavigate={navigate} onLogin={(nextUser) => {
      setUser(nextUser); navigate(takeReturnPath(manifest.product.id));
    }} />;
  }
  return <App manifest={manifest} user={user} onLogout={async () => {
    await logout(); setUser(null); navigate('/login');
  }} />;
}
