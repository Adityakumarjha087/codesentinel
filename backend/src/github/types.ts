export interface RepoRef {
  installationId: number | null;
  owner: string;
  repo: string;
}

export interface PullRequestFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
  previousFilename?: string;
}

export interface InlineComment {
  path: string;
  line: number;
  startLine?: number;
  side: 'RIGHT';
  body: string;
}

export interface CreateReviewInput {
  prNumber: number;
  commitSha: string;
  body: string;
  comments: InlineComment[];
}

export interface CreatedReview {
  id: number;
  /** Comment ids in the same order as the submitted comments. */
  commentIds: number[];
}

/** The subset of the GitHub API CodeSentinel depends on — implemented by Octokit (live) and fixtures (mock). */
export interface GitHubGateway {
  readonly mode: 'mock' | 'live';
  listPullRequestFiles(ref: RepoRef, prNumber: number): Promise<PullRequestFile[]>;
  getFileContent(ref: RepoRef, path: string, gitRef: string): Promise<string | null>;
  listFiles(ref: RepoRef, gitRef: string): Promise<{ path: string; size: number }[]>;
  createReview(ref: RepoRef, input: CreateReviewInput): Promise<CreatedReview>;
  createIssueComment(ref: RepoRef, prNumber: number, body: string): Promise<{ id: number }>;
}
