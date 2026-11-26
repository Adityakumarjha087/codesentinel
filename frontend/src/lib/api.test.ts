import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = { accessToken: 'tok-2', expiresIn: 900, user: { id: 'u', login: 'demo', name: null, avatarUrl: null, role: 'admin' } };

describe('ApiClient', () => {
  it('refreshes the session on 401 and retries once with the new token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: 'unauthorized', message: 'expired' }))
      .mockResolvedValueOnce(json(200, session))
      .mockResolvedValueOnce(json(200, [{ id: 'repo' }]));
    const client = new ApiClient('', fetchMock as unknown as typeof fetch);
    const listener = vi.fn();
    client.onSessionChange(listener);
    await expect(client.repos()).resolves.toEqual([{ id: 'repo' }]);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/refresh');
    const retried = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(new Headers(retried.headers).get('authorization')).toBe('Bearer tok-2');
    expect(listener).toHaveBeenCalledWith(session);
  });

  it('surfaces API errors with code and message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(403, { error: 'forbidden', message: 'Requires admin role' }));
    const client = new ApiClient('', fetchMock as unknown as typeof fetch);
    const err = await client.updateRepo('x', { isActive: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'Requires admin role' });
    const sent = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(sent.method).toBe('PATCH');
    expect(new Headers(sent.headers).get('content-type')).toBe('application/json');
  });

  it('clears the session when refresh fails and dedupes concurrent refreshes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, {}));
    const client = new ApiClient('', fetchMock as unknown as typeof fetch);
    const listener = vi.fn();
    client.onSessionChange(listener);
    const [a, b] = await Promise.all([client.refresh(), client.refresh()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('logs in, builds query strings and logs out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, session))
      .mockResolvedValueOnce(json(200, { total: 0, page: 2, pageSize: 5, items: [] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient('', fetchMock as unknown as typeof fetch);
    await client.devLogin('demo', 'admin');
    await client.reviews({ page: 2, pageSize: 5, status: '' });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/reviews?page=2&pageSize=5');
    await client.logout();
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/auth/logout');
  });
});
