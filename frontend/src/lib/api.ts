import type { AdminUser, ChatMessage, Finding, FindingStatus, Overview, Paged, Repo, ReviewDetail, ReviewListItem, Role, Session, User } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = (session: Session | null) => void;

/**
 * Thin typed client for the CodeSentinel API. The access token lives in memory only;
 * the refresh token is an httpOnly cookie scoped to /api/auth, rotated on every refresh.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<Session | null> | null = null;
  private listeners = new Set<Listener>();

  constructor(
    private readonly baseUrl = '',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  onSessionChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setSession(session: Session | null) {
    this.accessToken = session?.accessToken ?? null;
    this.listeners.forEach((l) => l(session));
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, credentials: 'include' });
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Request failed (${res.status})`);
    return body as T;
  }

  async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const res = await this.raw(path, init);
    if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
      const session = await this.refresh();
      if (session) return this.request<T>(path, init, false);
    }
    return this.parse<T>(res);
  }

  /** Exchange the refresh cookie for a new access token (deduplicated across concurrent callers). */
  refresh(): Promise<Session | null> {
    this.refreshing ??= (async () => {
      try {
        const res = await this.raw('/api/auth/refresh', { method: 'POST' });
        if (!res.ok) {
          this.setSession(null);
          return null;
        }
        const session = (await res.json()) as Session;
        this.setSession(session);
        return session;
      } catch {
        this.setSession(null);
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async devLogin(login: string, role: Role): Promise<Session> {
    const session = await this.request<Session>('/api/auth/dev-login', { method: 'POST', body: JSON.stringify({ login, role }) });
    this.setSession(session);
    return session;
  }

  async logout(): Promise<void> {
    await this.raw('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    this.setSession(null);
  }

  authConfig = () => this.request<{ githubOAuth: boolean; devLogin: boolean }>('/api/auth/config');
  me = () => this.request<User>('/api/auth/me');
  repos = () => this.request<Repo[]>('/api/repos');
  updateRepo = (id: string, body: { monthlyTokenBudget?: number; isActive?: boolean }) =>
    this.request<Repo>(`/api/repos/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  reindexRepo = (id: string) => this.request<{ status: string }>(`/api/repos/${id}/reindex`, { method: 'POST' });
  reviews = (params: { repoId?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    return this.request<Paged<ReviewListItem>>(`/api/reviews${q.size ? `?${q}` : ''}`);
  };
  review = (id: string) => this.request<ReviewDetail>(`/api/reviews/${id}`);
  rerunReview = (id: string) => this.request<{ reviewId: string }>(`/api/reviews/${id}/rerun`, { method: 'POST' });
  updateFinding = (id: string, status: Exclude<FindingStatus, 'resolved'>) =>
    this.request<Finding>(`/api/findings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
  overview = (days = 30, repoId?: string) => this.request<Overview>(`/api/stats/overview?days=${days}${repoId ? `&repoId=${repoId}` : ''}`);
  chatHistory = (prId: string) => this.request<ChatMessage[]>(`/api/pull-requests/${prId}/chat`);
  askChat = (prId: string, message: string) =>
    this.request<{ question: ChatMessage; answer: ChatMessage }>(`/api/pull-requests/${prId}/chat`, { method: 'POST', body: JSON.stringify({ message }) });
  users = () => this.request<AdminUser[]>('/api/users');
  updateUserRole = (id: string, role: Role) => this.request<User>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
}

export const api = new ApiClient();
