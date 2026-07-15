import { useState } from 'react';
import { ApiError, authMessage, register } from './api';
import { AuthFrame } from './LoginPage';

export function RegisterPage({ onRegistered, onNavigate }: {
  onRegistered(email: string): void; onNavigate(path: string): void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  return <AuthFrame title="创建工作区账号" note="邮箱验证后即可登录">
    <form onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError('');
      const data = new FormData(event.currentTarget);
      const email = String(data.get('email'));
      try {
        await register({ email, username: String(data.get('username')), password: String(data.get('password')) });
        onRegistered(email);
      } catch (cause) { setError(authMessage(cause instanceof ApiError ? cause.code : 'REQUEST_FAILED')); }
      finally { setPending(false); }
    }}>
      <label>邮箱<input name="email" type="email" autoComplete="email" required /></label>
      <label>用户名<input name="username" autoComplete="username" required minLength={3} maxLength={32} /></label>
      <label>密码<input name="password" type="password" autoComplete="new-password" required minLength={10} /></label>
      <p className="auth-error" aria-live="polite">{error}</p>
      <button className="auth-primary" disabled={pending}>{pending ? '创建中…' : '注册并发送验证码'}</button>
    </form>
    <button className="auth-link" onClick={() => onNavigate('/login')}>已有账号，返回登录</button>
  </AuthFrame>;
}
