import { useState, type ReactNode } from 'react';
import { ApiError, authMessage, login, type SessionUser } from './api';

export function LoginPage({ onLogin, onNavigate }: {
  onLogin(user: SessionUser): void;
  onNavigate(path: string): void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  return <AuthFrame title="重新进入工作区" note="使用邮箱或用户名登录">
    <form onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError('');
      const data = new FormData(event.currentTarget);
      try {
        const result = await login({
          identifier: String(data.get('identifier')),
          password: String(data.get('password')),
        });
        onLogin(result.user);
      } catch (cause) {
        setError(authMessage(cause instanceof ApiError ? cause.code : 'REQUEST_FAILED'));
      } finally { setPending(false); }
    }}>
      <label>邮箱或用户名<input name="identifier" autoComplete="username" required /></label>
      <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
      <p className="auth-error" aria-live="polite">{error}</p>
      <button className="auth-primary" disabled={pending}>{pending ? '登录中…' : '登录'}</button>
    </form>
    <button className="auth-link" onClick={() => onNavigate('/register')}>注册新账号</button>
  </AuthFrame>;
}

export function AuthFrame({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <main className="auth-page"><section className="auth-card">
    <span className="product-mark">P</span><p className="eyebrow">路线工作空间</p>
    <h1>{title}</h1><p className="auth-note">{note}</p>{children}
  </section></main>;
}
