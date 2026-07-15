export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.error?.code ?? 'REQUEST_FAILED', response.status);
  return body as T;
}

export interface SessionUser { id: string; email: string; username: string }
export const getSession = () => request<{ user: SessionUser }>('/api/auth/session');
export const register = (input: { email: string; username: string; password: string }) =>
  request<{ maskedEmail: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
export const verifyEmail = (input: { email: string; code: string }) =>
  request<{ ok: true }>('/api/auth/verify-email', { method: 'POST', body: JSON.stringify(input) });
export const resendVerification = (email: string) =>
  request<{ accepted: true }>('/api/auth/verification/resend', { method: 'POST', body: JSON.stringify({ email }) });
export const login = (input: { identifier: string; password: string }) =>
  request<{ user: SessionUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
export const logout = () => request<void>('/api/auth/logout', { method: 'POST' });

export const authMessage = (code: string) => ({
  EMAIL_TAKEN: '这个邮箱已经注册。',
  USERNAME_TAKEN: '这个用户名已经被使用。',
  INVALID_CREDENTIALS: '邮箱、用户名或密码不正确。',
  INVALID_VERIFICATION_CODE: '验证码不正确。',
  VERIFICATION_EXPIRED: '验证码已过期，请重新发送。',
  MAIL_DELIVERY_FAILED: '邮件暂时无法发送，请稍后重试。',
}[code] ?? '请求没有完成，请稍后重试。');
