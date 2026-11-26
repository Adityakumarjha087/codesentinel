import type { Finding, FindingSeverity, SkippedFile } from '../db/schema.js';
import type { RepoConfig } from '../review/config.js';
import { severityRank } from '../review/config.js';

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

const CATEGORY_LABEL: Record<Finding['category'], string> = {
  bug: 'Bug',
  security: 'Security',
  performance: 'Performance',
  readability: 'Readability',
};

export type CommentFinding = Pick<Finding, 'severity' | 'category' | 'title' | 'explanation' | 'suggestion' | 'ruleId' | 'confidence'>;

/** Inline review comment body with a GitHub `suggestion` block when a fix is available. */
export function formatInlineComment(f: CommentFinding): string {
  const parts = [
    `**CodeSentinel** · \`${SEVERITY_LABEL[f.severity]}\` · ${CATEGORY_LABEL[f.category]}${f.ruleId ? ` · \`${f.ruleId}\`` : ''}`,
    '',
    `**${f.title}**`,
    '',
    f.explanation,
  ];
  if (f.suggestion !== null && f.suggestion !== undefined) {
    parts.push('', '```suggestion', f.suggestion, '```');
  }
  parts.push('', `<sub>Confidence ${Math.round(f.confidence * 100)}% · Mark this as accepted or dismissed in the CodeSentinel dashboard.</sub>`);
  return parts.join('\n');
}

const INTRO: Record<RepoConfig['tone'], (n: number) => string> = {
  friendly: (n) => (n ? `Thanks for the PR! I took a look and left ${n} note${n === 1 ? '' : 's'} below.` : 'Thanks for the PR! I did not spot any issues. Nice work.'),
  neutral: (n) => (n ? `CodeSentinel reviewed this pull request and reported ${n} finding${n === 1 ? '' : 's'}.` : 'CodeSentinel reviewed this pull request and found no issues.'),
  strict: (n) => (n ? `${n} issue${n === 1 ? '' : 's'} must be addressed before this can merge.` : 'No issues found.'),
};

export interface SummaryInput {
  findings: CommentFinding[];
  outOfDiff: CommentFinding[];
  filesReviewed: number;
  skipped: SkippedFile[];
  config: RepoConfig;
  configErrors: string[];
  passes: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; model: string };
  dashboardUrl?: string;
}

export function formatSummary(s: SummaryInput): string {
  const all = [...s.findings, ...s.outOfDiff];
  const severities: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
  const lines = ['## CodeSentinel review', '', INTRO[s.config.tone](all.length), ''];
  if (all.length) {
    lines.push('| Severity | Count |', '| --- | ---: |');
    for (const sev of severities) {
      const n = all.filter((f) => f.severity === sev).length;
      if (n > 0) lines.push(`| ${SEVERITY_LABEL[sev]} | ${n} |`);
    }
    lines.push('');
    const byCategory = new Map<string, number>();
    for (const f of all) byCategory.set(CATEGORY_LABEL[f.category], (byCategory.get(CATEGORY_LABEL[f.category]) ?? 0) + 1);
    lines.push(`**By category:** ${[...byCategory].map(([c, n]) => `${c} ${n}`).join(' · ')}`, '');
    const top = [...all].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, 5);
    lines.push('**Top issues**', ...top.map((f) => `- \`${SEVERITY_LABEL[f.severity]}\` ${f.title}`), '');
  }
  if (s.outOfDiff.length) {
    lines.push(`${s.outOfDiff.length} finding(s) reference lines outside the diff and are listed here only.`, '');
  }
  lines.push(`Reviewed **${s.filesReviewed}** file(s) with passes: ${s.passes.join(', ') || 'none'}.`);
  if (s.skipped.length) {
    lines.push('', '<details><summary>Skipped files</summary>', '', ...s.skipped.map((f) => `- \`${f.path}\`: ${f.reason}`), '', '</details>');
  }
  if (s.configErrors.length) {
    lines.push('', '> **.codesentinel.yml could not be applied** (defaults used):', ...s.configErrors.map((e) => `> - ${e}`));
  }
  lines.push(
    '',
    `<sub>Model \`${s.usage.model}\` · ${s.usage.inputTokens + s.usage.outputTokens} tokens · $${s.usage.costUsd.toFixed(4)}${s.dashboardUrl ? ` · [Open in dashboard](${s.dashboardUrl})` : ''}</sub>`,
  );
  return lines.join('\n');
}
