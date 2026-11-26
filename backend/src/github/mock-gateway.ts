import { structuredPatch } from 'diff';
import { FIXTURE_REPOSITORIES, prShas, type FixtureRepository } from '../fixtures/repos.js';
import type { CreateReviewInput, CreatedReview, GitHubGateway, PullRequestFile, RepoRef } from './types.js';

export interface RecordedReview extends CreateReviewInput {
  repo: string;
  id: number;
}

/** Compute a GitHub-style patch (hunks only) between two file versions. */
export function computePatch(path: string, before: string, after: string): { patch: string; additions: number; deletions: number } {
  const sp = structuredPatch(path, path, before, after, '', '', { context: 3 });
  let additions = 0;
  let deletions = 0;
  const out: string[] = [];
  for (const h of sp.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue;
      if (l.startsWith('+')) additions++;
      else if (l.startsWith('-')) deletions++;
      out.push(l);
    }
  }
  return { patch: out.join('\n'), additions, deletions };
}

/**
 * Offline GitHub backed by fixture repositories. Reads are served from fixtures and
 * writes (reviews, comments) are recorded in memory so tests can assert on them.
 */
export class MockGitHubGateway implements GitHubGateway {
  readonly mode = 'mock' as const;
  readonly reviews: RecordedReview[] = [];
  readonly issueComments: { repo: string; prNumber: number; body: string; id: number }[] = [];
  private nextId = 5_000_000;

  constructor(private readonly repos: FixtureRepository[] = FIXTURE_REPOSITORIES) {}

  private repo(ref: RepoRef): FixtureRepository {
    const repo = this.repos.find((r) => r.owner === ref.owner && r.name === ref.repo);
    if (!repo) throw Object.assign(new Error(`Fixture repository ${ref.owner}/${ref.repo} not found`), { status: 404 });
    return repo;
  }

  private filesAt(repo: FixtureRepository, gitRef: string): Record<string, string> {
    const pr = repo.pullRequests.find((p) => prShas(repo, p).headSha === gitRef || p.headRef === gitRef);
    if (!pr) return repo.files;
    const files = { ...repo.files };
    for (const [path, content] of Object.entries(pr.changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }
    return files;
  }

  async listPullRequestFiles(ref: RepoRef, prNumber: number): Promise<PullRequestFile[]> {
    const repo = this.repo(ref);
    const pr = repo.pullRequests.find((p) => p.number === prNumber);
    if (!pr) throw Object.assign(new Error(`Fixture PR #${prNumber} not found`), { status: 404 });
    return Object.entries(pr.changes).map(([path, content]) => {
      const before = repo.files[path];
      const status: PullRequestFile['status'] = content === null ? 'removed' : before === undefined ? 'added' : 'modified';
      const { patch, additions, deletions } = computePatch(path, before ?? '', content ?? '');
      return { filename: path, status, additions, deletions, patch };
    });
  }

  async getFileContent(ref: RepoRef, path: string, gitRef: string): Promise<string | null> {
    return this.filesAt(this.repo(ref), gitRef)[path] ?? null;
  }

  async listFiles(ref: RepoRef, gitRef: string): Promise<{ path: string; size: number }[]> {
    return Object.entries(this.filesAt(this.repo(ref), gitRef)).map(([path, content]) => ({ path, size: Buffer.byteLength(content) }));
  }

  async createReview(ref: RepoRef, input: CreateReviewInput): Promise<CreatedReview> {
    const id = this.nextId++;
    this.reviews.push({ ...input, repo: `${ref.owner}/${ref.repo}`, id });
    return { id, commentIds: input.comments.map(() => this.nextId++) };
  }

  async createIssueComment(ref: RepoRef, prNumber: number, body: string): Promise<{ id: number }> {
    const id = this.nextId++;
    this.issueComments.push({ repo: `${ref.owner}/${ref.repo}`, prNumber, body, id });
    return { id };
  }
}
