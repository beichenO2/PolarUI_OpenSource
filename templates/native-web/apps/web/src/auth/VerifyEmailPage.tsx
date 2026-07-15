import { useEffect, useState } from 'react';
import { ApiError, authMessage, resendVerification, verifyEmail } from './api';
import { AuthFrame } from './LoginPage';

export function VerifyEmailPage({ email, onVerified }: { email: string; onVerified(): void }) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [resendPending, setResendPending] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(60);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendSeconds((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  return <AuthFrame title="验证邮箱" note={'验证码已发送至 ' + email}>
    <form onSubmit={async (event) => {
      event.preventDefault(); setPending(true); setError('');
      const code = String(new FormData(event.currentTarget).get('code'));
      try { await verifyEmail({ email, code }); onVerified(); }
      catch (cause) { setError(authMessage(cause instanceof ApiError ? cause.code : 'REQUEST_FAILED')); }
      finally { setPending(false); }
    }}>
      <label>六位验证码<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
      <p className="auth-error" aria-live="polite">{error}</p>
      <button className="auth-primary" disabled={pending}>{pending ? '验证中…' : '完成验证'}</button>
    </form>
    <button className="auth-link" disabled={resendSeconds > 0 || resendPending} onClick={async () => {
      setResendPending(true); setError('');
      try {
        await resendVerification(email);
        setNotice('如果账号可验证，新验证码已经发送。');
        setResendSeconds(60);
      } catch (cause) {
        setError(authMessage(cause instanceof ApiError ? cause.code : 'REQUEST_FAILED'));
      } finally { setResendPending(false); }
    }}>{resendPending ? '发送中…' : resendSeconds > 0 ? `${resendSeconds} 秒后可重新发送` : '重新发送验证码'}</button>
    <p className="auth-notice" aria-live="polite">{notice}</p>
  </AuthFrame>;
}
