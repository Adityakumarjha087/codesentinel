import { z } from 'zod';
import type { FindingCategory } from '../db/schema.js';
import type { ToolDefinition } from '../llm/types.js';
import type { RepoConfig, ReviewPassId } from './config.js';

export interface PassDefinition {
  id: ReviewPassId;
  category: FindingCategory;
  label: string;
  focus: string;
}

export const PASSES: Record<ReviewPassId, PassDefinition> = {
  bugs: {
    id: 'bugs',
    category: 'bug',
    label: 'Bugs & logic errors',
    focus:
      'Logic errors, off-by-one mistakes, null/undefined handling, incorrect conditions, swallowed errors, race conditions, unhandled promise rejections, wrong API usage and broken edge cases.',
  },
  security: {
    id: 'security',
    category: 'security',
    label: 'Security',
    focus:
      'Injection (SQL, command, template), XSS, hardcoded secrets or credentials, unsafe deserialization, path traversal, weak cryptography, insecure randomness, disabled TLS verification, missing authorization checks and SSRF.',
  },
  performance: {
    id: 'performance',
    category: 'performance',
    label: 'Performance',
    focus:
      'Sequential awaits in loops (N+1), quadratic lookups, blocking synchronous I/O on hot paths, unnecessary deep copies, unbounded queries (SELECT *), repeated expensive work inside loops and memory leaks.',
  },
  readability: {
    id: 'readability',
    category: 'readability',
    label: 'Readability & best practices',
    focus:
      'Leftover debug logging, unclear naming, overly long or deeply nested functions, `any` types, legacy `var`, TODO/FIXME markers, nested ternaries and deviations from idiomatic style.',
  },
};

export const REPORT_FINDINGS_TOOL = 'report_findings';

export const reportFindingsTool: ToolDefinition = {
  name: REPORT_FINDINGS_TOOL,
  description: 'Report every code review finding for this pass. Call exactly once; pass an empty array when there are no issues.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'line', 'end_line', 'severity', 'title', 'explanation', 'suggestion', 'rule_id', 'confidence'],
          properties: {
            file: { type: 'string', description: 'File path exactly as given in the <file path> attribute.' },
            line: { type: 'integer', description: 'New-file line number (left column of the numbered diff).' },
            end_line: { type: ['integer', 'null'], description: 'Last line for multi-line findings, else null.' },
            severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
            title: { type: 'string', description: 'Short imperative summary (max ~80 chars).' },
            explanation: { type: 'string', description: 'Why this is a problem and its impact.' },
            suggestion: {
              type: ['string', 'null'],
              description: 'Replacement source for lines line..end_line (exact code, no markdown fences), or null.',
            },
            rule_id: { type: 'string', description: 'Stable kebab-case id, e.g. security/sql-injection.' },
            confidence: { type: 'number', description: '0..1 confidence that this is a real issue.' },
          },
        },
      },
    },
  },
};

export const rawFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().nullable().optional(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  title: z.string().min(1).max(300),
  explanation: z.string().min(1).max(4000),
  suggestion: z.string().max(4000).nullable().optional(),
  rule_id: z.string().max(120).optional().default('general'),
  confidence: z.number().min(0).max(1).optional().default(0.7),
});
export type RawFinding = z.infer<typeof rawFindingSchema>;

const TONES: Record<RepoConfig['tone'], string> = {
  friendly: 'Be warm and encouraging; frame issues as collaborative suggestions.',
  neutral: 'Be concise, factual and professional.',
  strict: 'Be direct and demanding; hold the code to a high production bar.',
};

export function buildSystemPrompt(pass: PassDefinition, config: RepoConfig): string {
  const lines = [
    'You are CodeSentinel, a senior staff engineer performing a focused pull request review.',
    `Review pass: ${pass.id}`,
    `Focus exclusively on: ${pass.focus}`,
    `Tone: ${config.tone}. ${TONES[config.tone]}`,
    'Only comment on lines that were added or modified in this pull request (marked with "+"). Use surrounding code and related repository code only as context.',
    'Cite the exact new-file line number from the left column. Suggestions must be drop-in replacement code for those lines, preserving indentation.',
    'Do not report style nits outside your focus area. Do not invent issues; prefer fewer, high-confidence findings.',
    `Call the ${REPORT_FINDINGS_TOOL} tool exactly once with all findings (empty array if none). Do not answer in prose.`,
  ];
  if (config.rules.instructions.length) {
    lines.push('Team guidelines from .codesentinel.yml:', ...config.rules.instructions.map((i) => `- ${i}`));
  }
  return lines.join('\n');
}

export interface PromptFile {
  path: string;
  language: string;
  numberedDiff: string;
  symbols: { name: string; kind: string; startLine: number; endLine: number; code: string }[];
}

export interface PromptRelatedChunk {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

export function buildReviewUserPrompt(input: {
  repo: string;
  prNumber: number;
  prTitle: string;
  files: PromptFile[];
  related: PromptRelatedChunk[];
}): string {
  const parts: string[] = [`Repository: ${input.repo}`, `Pull request #${input.prNumber}: ${input.prTitle}`, ''];
  for (const f of input.files) {
    parts.push(`<file path="${f.path}" language="${f.language}">`);
    if (f.symbols.length) {
      parts.push('<changed_symbols>');
      for (const s of f.symbols) parts.push(`- ${s.kind} ${s.name} (lines ${s.startLine}-${s.endLine})`);
      parts.push('</changed_symbols>');
    }
    parts.push('<diff>', f.numberedDiff, '</diff>');
    for (const s of f.symbols) {
      if (!s.code) continue;
      parts.push(`<symbol_context name="${s.name}">`, s.code, '</symbol_context>');
    }
    parts.push('</file>', '');
  }
  if (input.related.length) {
    parts.push('<related_code note="Retrieved from the repository embedding index for context only; do not review it.">');
    for (const r of input.related) {
      parts.push(`<snippet path="${r.path}" symbol="${r.symbol ?? ''}" lines="${r.startLine}-${r.endLine}">`, r.content, '</snippet>');
    }
    parts.push('</related_code>');
  }
  return parts.join('\n');
}
