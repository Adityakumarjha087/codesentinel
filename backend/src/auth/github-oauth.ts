import { AppError } from '../lib/errors.js';
import type { FetchLike } from '../llm/types.js';

export interface GitHubOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
  webUrl: string;
  apiUrl: string;
  fetch?: FetchLike;
}

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/** GitHub OAuth web flow ("Sign in with GitHub"). */
export class GitHubOAuth {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GitHubOAuthOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get enabled(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  authorizeUrl(state: string): string {
    const url = new URL('/login/oauth/authorize', this.opts.webUrl);
    url.searchParams.set('client_id', this.opts.clientId ?? '');
    url.searchParams.set('redirect_uri', this.opts.callbackUrl);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  async exchangeCode(code: string): Promise<string> {
    const res = await this.fetchImpl(new URL('/login/oauth/access_token', this.opts.webUrl).toString(), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code, redirect_uri: this.opts.callbackUrl }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new AppError(401, 'oauth_failed', data.error_description ?? 'GitHub OAuth code exchange failed');
    return data.access_token;
  }

  async fetchProfile(accessToken: string): Promise<GitHubProfile> {
    const res = await this.fetchImpl(new URL('/user', this.opts.apiUrl).toString(), {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'codesentinel' },
    });
    if (!res.ok) throw new AppError(401, 'oauth_failed', `GitHub user lookup failed (${res.status})`);
    return (await res.json()) as GitHubProfile;
  }
}
