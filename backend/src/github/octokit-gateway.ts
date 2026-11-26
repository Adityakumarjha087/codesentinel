import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { FetchLike } from '../llm/types.js';
import type { CreateReviewInput, CreatedReview, GitHubGateway, PullRequestFile, RepoRef } from './types.js';

export interface OctokitGatewayOptions {
  appId: string;
  privateKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Test hook: supply a pre-authenticated client instead of GitHub App auth. */
  clientFactory?: (installationId: number | null) => Octokit;
}

/** Live GitHub implementation using installation tokens of the GitHub App. */
export class OctokitGateway implements GitHubGateway {
  readonly mode = 'live' as const;
  private readonly clients = new Map<number, Octokit>();

  constructor(private readonly opts: OctokitGatewayOptions) {}

  private client(installationId: number | null): Octokit {
    if (this.opts.clientFactory) return this.opts.clientFactory(installationId);
    if (installationId == null) throw new Error('Repository has no GitHub App installation');
    let client = this.clients.get(installationId);
    if (!client) {
      client = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: this.opts.appId, privateKey: this.opts.privateKey, installationId },
        baseUrl: this.opts.baseUrl,
        request: this.opts.fetch ? { fetch: this.opts.fetch } : undefined,
        userAgent: 'codesentinel',
      });
      this.clients.set(installationId, client);
    }
    return client;
  }

  async listPullRequestFiles(ref: RepoRef, prNumber: number): Promise<PullRequestFile[]> {
    const files = await this.client(ref.installationId).paginate(this.client(ref.installationId).rest.pulls.listFiles, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      previousFilename: f.previous_filename,
    }));
  }

  async getFileContent(ref: RepoRef, path: string, gitRef: string): Promise<string | null> {
    try {
      const res = await this.client(ref.installationId).rest.repos.getContent({ owner: ref.owner, repo: ref.repo, path, ref: gitRef });
      const data = res.data;
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      return Buffer.from(data.content, (data.encoding as BufferEncoding) || 'base64').toString('utf8');
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async listFiles(ref: RepoRef, gitRef: string): Promise<{ path: string; size: number }[]> {
    const res = await this.client(ref.installationId).rest.git.getTree({ owner: ref.owner, repo: ref.repo, tree_sha: gitRef, recursive: 'true' });
    return res.data.tree.filter((e) => e.type === 'blob' && e.path).map((e) => ({ path: e.path!, size: e.size ?? 0 }));
  }

  async createReview(ref: RepoRef, input: CreateReviewInput): Promise<CreatedReview> {
    const client = this.client(ref.installationId);
    const res = await client.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: input.prNumber,
      commit_id: input.commitSha,
      event: 'COMMENT',
      body: input.body,
      comments: input.comments.map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        body: c.body,
        ...(c.startLine && c.startLine < c.line ? { start_line: c.startLine, start_side: c.side } : {}),
      })),
    });
    const posted = input.comments.length
      ? await client.paginate(client.rest.pulls.listCommentsForReview, {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: input.prNumber,
          review_id: res.data.id,
          per_page: 100,
        })
      : [];
    const commentIds = input.comments.map((c) => {
      const match = posted.find((p) => p.path === c.path && (p.line ?? p.original_line) === c.line && p.body === c.body);
      return match?.id ?? 0;
    });
    return { id: res.data.id, commentIds };
  }

  async createIssueComment(ref: RepoRef, prNumber: number, body: string): Promise<{ id: number }> {
    const res = await this.client(ref.installationId).rest.issues.createComment({ owner: ref.owner, repo: ref.repo, issue_number: prNumber, body });
    return { id: res.data.id };
  }
}
