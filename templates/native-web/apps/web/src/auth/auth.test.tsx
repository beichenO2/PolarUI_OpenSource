import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicProductManifest } from '../App';
import { AuthGate } from './AuthGate';
import { authMessage } from './api';
import { VerifyEmailPage } from './VerifyEmailPage';

const manifest: PublicProductManifest = {
  contract_version: '1.0',
  product: { id: 'identity-demo', name: 'Workflow Workspace', context_label: '情境', route_label: '路线' },
  workflow: { id: 'demo' },
  stages: [
    { key: 'discover', label: '发现', component_key: 'generic_chat', internal_states: ['start'], actions: [] },
  ],
};

const demoManifest = {
  ...manifest,
  demo_login: {
    email: 'demo@native-web.test',
    username: 'demo',
    password: 'Demo-Workflow-2026!',
  },
} as PublicProductManifest;

const user = { id: 'user-1', email: 'reader@example.test', username: 'reader' };
const context = {
  id: '20000000-0000-4000-8000-000000000001', title: 'Research', status: 'active',
  createdAt: '2026-07-15T16:00:00.000Z', updatedAt: '2026-07-15T16:00:00.000Z',
};
const checkpoint = {
  id: '40000000-0000-4000-8000-000000000001', contextId: context.id,
  routeId: '30000000-0000-4000-8000-000000000001', parentCheckpointId: null,
  version: 0, stageKey: 'discover', reason: 'bootstrap', snapshot: { stages: [] },
  createdAt: '2026-07-15T16:00:00.000Z',
};
const route = {
  id: checkpoint.routeId, contextId: context.id, name: '主线', originCheckpointId: null,
  headCheckpointId: checkpoint.id, createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
};
const protectedPath = `/contexts/${context.id}/routes/${route.id}/stages/discover?thread=branch-a`;
const routeBody = {
  context, route,
  stages: [{ stageKey: 'discover', position: 0, status: 'active', internalState: 'start', label: '发现', componentKey: 'generic_chat' }],
  checkpoints: [checkpoint],
  threads: [{
    id: 'branch-a', contextId: context.id, routeId: route.id, stageKey: 'discover', title: 'Branch A',
    status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
  }],
  selectedStageKey: 'discover', selectedCheckpoint: checkpoint, isHistorical: false,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('native identity UI', () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends unauthenticated protected visits to login and scopes the return path by product', async () => {
    history.replaceState({}, '', '/stages/discover?thread=branch-a');
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401)));

    render(<AuthGate manifest={manifest} />);

    expect(await screen.findByRole('heading', { name: '重新进入工作区' })).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱或用户名')).toHaveAttribute('autocomplete', 'username');
    expect(localStorage.getItem('polar-native:identity-demo:return-path')).toBe('/stages/discover?thread=branch-a');
  });

  it('prefills the configured demo account so login is one click', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401)));

    render(<AuthGate manifest={demoManifest} />);

    expect(await screen.findByLabelText('邮箱或用户名')).toHaveValue('demo');
    expect(screen.getByLabelText('密码')).toHaveValue('Demo-Workflow-2026!');
  });

  it('registers with email, username, and password without persisting credentials', async () => {
    history.replaceState({}, '', '/register');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/auth/session') return jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401);
      if (url === '/api/auth/register') return jsonResponse({ maskedEmail: 'r***@example.test' }, 201);
      throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthGate manifest={manifest} />);
    await screen.findByRole('heading', { name: '创建工作区账号' });
    await userEvent.type(screen.getByLabelText('邮箱'), 'reader@example.test');
    await userEvent.type(screen.getByLabelText('用户名'), 'reader');
    await userEvent.type(screen.getByLabelText('密码'), 'not-a-real-password');
    await userEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));

    expect(await screen.findByRole('heading', { name: '验证邮箱' })).toBeInTheDocument();
    const request = fetchMock.mock.calls.find(([url]) => url === '/api/auth/register');
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      email: 'reader@example.test', username: 'reader', password: 'not-a-real-password',
    });
    expect(Object.values(localStorage).join('\n')).not.toContain('not-a-real-password');
  });

  it('accepts one six-digit code and exposes the resend countdown', async () => {
    const onVerified = vi.fn();
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/verify-email') return jsonResponse({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    }));

    render(<VerifyEmailPage email="reader@example.test" onVerified={onVerified} />);

    const input = screen.getByLabelText('六位验证码');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('pattern', '[0-9]{6}');
    expect(screen.getByRole('button', { name: /60 秒后可重新发送/ })).toBeDisabled();

    await userEvent.type(input, '123456');
    await userEvent.click(screen.getByRole('button', { name: '完成验证' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(Object.values(localStorage).join('\n')).not.toContain('123456');
  });

  it('returns to the protected URL after login without restoring a legacy stage note', async () => {
    history.replaceState({}, '', protectedPath);
    localStorage.setItem(`polar-native:identity-demo:draft:${protectedPath}`, '未提交的研究备忘');
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/session') return jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401);
      if (url === '/api/auth/login') return jsonResponse({ user });
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeBody);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthGate manifest={manifest} />);
    await screen.findByRole('heading', { name: '重新进入工作区' });
    await userEvent.type(screen.getByLabelText('邮箱或用户名'), 'reader');
    await userEvent.type(screen.getByLabelText('密码'), 'not-a-real-password');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    await screen.findByTestId('workspace-slot');
    expect(screen.queryByDisplayValue('未提交的研究备忘')).not.toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(protectedPath);
    expect(localStorage.getItem('polar-native:identity-demo:return-path')).toBeNull();
    expect(Object.values(localStorage).join('\n')).not.toContain('not-a-real-password');
  });

  it('renders the workflow shell immediately for a valid session user', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/session') return jsonResponse({ user });
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeBody);
      throw new Error(`unexpected request: ${url}`);
    }));
    render(<AuthGate manifest={manifest} />);
    expect(await screen.findByTestId('workspace-slot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reader · 退出/ })).toBeInTheDocument();
  });

  it('maps stable API error codes to concise Chinese messages', () => {
    expect(authMessage('EMAIL_TAKEN')).toBe('这个邮箱已经注册。');
    expect(authMessage('INVALID_CREDENTIALS')).toBe('邮箱、用户名或密码不正确。');
    expect(authMessage('UNKNOWN_CODE')).toBe('请求没有完成，请稍后重试。');
  });
});
