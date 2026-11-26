export type Role = 'admin' | 'maintainer' | 'viewer';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Category = 'bug' | 'security' | 'performance' | 'readability';
export type FindingStatus = 'open' | 'accepted' | 'rejected' | 'resolved';
export type ReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export interface Repo {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  isActive: boolean;
  defaultBranch: string;
  indexedAt: string | null;
  monthlyTokenBudget: number;
  reviewCount: number;
  lastReviewAt: string | null;
  openFindings: number;
  totalFindings: number;
  tokensThisMonth: number;
  costThisMonth: number;
}

export interface ReviewListItem {
  id: string;
  status: ReviewStatus;
  trigger: string;
  skipReason: string | null;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string | null;
  filesReviewed: number;
  headSha: string;
  repo: { id: string; fullName: string };
  pullRequest: { id: string; number: number; title: string; author: string; url: string | null };
  findingsCount: number;
  bySeverity: Partial<Record<Severity, number>>;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface Finding {
  id: string;
  reviewId: string;
  category: Category;
  severity: Severity;
  filePath: string;
  line: number;
  endLine: number | null;
  title: string;
  explanation: string;
  suggestion: string | null;
  ruleId: string | null;
  symbol: string | null;
  codeSnippet: string | null;
  confidence: number;
  inDiff: boolean;
  status: FindingStatus;
  createdAt: string;
}

export interface ReviewFile {
  id: string;
  path: string;
  status: string;
  language: string | null;
  additions: number;
  deletions: number;
  patch: string | null;
  baseContent: string | null;
  headContent: string | null;
  symbols: { name: string; kind: string; startLine: number; endLine: number }[];
  skippedReason: string | null;
}

export interface ReviewDetail {
  review: {
    id: string;
    status: ReviewStatus;
    summary: string | null;
    skipReason: string | null;
    error: string | null;
    provider: string | null;
    model: string | null;
    filesReviewed: number;
    filesSkipped: { path: string; reason: string }[];
    passes: string[];
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number | null;
    createdAt: string;
    headSha: string;
    trigger: string;
    postedAt: string | null;
  };
  pullRequest: { id: string; number: number; title: string; author: string; url: string | null; headRef: string; baseRef: string; state: string };
  repository: { id: string; fullName: string; config: Record<string, unknown> | null };
  files: ReviewFile[];
  findings: Finding[];
  history: { id: string; status: ReviewStatus; createdAt: string; headSha: string }[];
}

export interface TimelinePoint {
  date: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  bug: number;
  security: number;
  performance: number;
  readability: number;
}

export interface Overview {
  days: number;
  reviews: { total: number; completed: number; skipped: number; failed: number; avgDurationMs: number };
  findings: { total: number; withSuggestion: number; open: number; accepted: number; rejected: number; resolved: number };
  acceptanceRate: number | null;
  byCategory: { category: Category; count: number }[];
  bySeverity: { severity: Severity; count: number }[];
  timeline: TimelinePoint[];
  topRules: { ruleId: string; category: Category; count: number }[];
  usage: { tokens: number; costUsd: number; byRepo: { repoId: string; repo: string; tokens: number; costUsd: number }[] };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: { type: string; ref: string; label: string }[];
  createdAt: string;
}

export interface AdminUser extends User {
  createdAt: string;
  lastLoginAt: string | null;
}
