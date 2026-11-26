import { estimateTokens } from '../../lib/tokens.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../types.js';
import { runMockRules, type MockCategory, type MockFileContext } from './rules.js';

export const MOCK_MODEL = 'codesentinel-mock-1';

const FILE_RE = /<file path="([^"]+)" language="([^"]+)">([\s\S]*?)<\/file>/g;
const ADDED_RE = /^\s*(\d+) \| \+ (.*)$/;
const NUMBERED_RE = /^\s*(\d+) \| {1,3}(.*)$/;
const SYMBOL_RE = /^- (\w+) (.+) \(lines (\d+)-(\d+)\)$/;

/** Parse the review prompt format produced by `buildReviewUserPrompt`. */
export function parseReviewPrompt(prompt: string): MockFileContext[] {
  const files: MockFileContext[] = [];
  for (const m of prompt.matchAll(FILE_RE)) {
    const [, path, language, body] = m;
    const file: MockFileContext = { path: path!, language: language!, added: [], known: new Map(), symbols: [] };
    let inDiff = false;
    for (const raw of (body ?? '').split('\n')) {
      if (raw === '<diff>') inDiff = true;
      else if (raw === '</diff>') inDiff = false;
      const sym = SYMBOL_RE.exec(raw);
      if (sym) {
        file.symbols.push({ kind: sym[1]!, name: sym[2]!, startLine: Number(sym[3]), endLine: Number(sym[4]) });
        continue;
      }
      const add = ADDED_RE.exec(raw);
      if (add && inDiff) {
        const line = { line: Number(add[1]), text: add[2]! };
        file.added.push(line);
        file.known.set(line.line, line.text);
        continue;
      }
      const num = NUMBERED_RE.exec(raw);
      if (num && !file.known.has(Number(num[1]))) file.known.set(Number(num[1]), num[2]!);
    }
    files.push(file);
  }
  return files;
}

interface ChatFindingRef {
  severity: string;
  category: string;
  location: string;
  title: string;
  suggestion?: string;
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function parseChatContext(prompt: string) {
  const findings: ChatFindingRef[] = [];
  const block = /<findings>([\s\S]*?)<\/findings>/.exec(prompt)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const m = /^- \[(\w+)\]\[(\w+)\] (\S+) — (.+?)(?: \|\| suggestion: (.*))?$/.exec(line.trim());
    if (m) findings.push({ severity: m[1]!, category: m[2]!, location: m[3]!, title: m[4]!, suggestion: m[5] });
  }
  const snippets = [...prompt.matchAll(/<snippet path="([^"]+)"/g)].map((s) => s[1]!);
  const pr = /Pull request #(\d+): (.*)/.exec(prompt);
  return { findings, snippets, prNumber: pr?.[1], prTitle: pr?.[2] };
}

/** Deterministic, grounded answer for PR chat in offline mode. */
export function mockChatAnswer(prompt: string, question: string): string {
  const ctx = parseChatContext(prompt);
  const q = question.toLowerCase();
  const categoryWords: Record<string, string[]> = {
    security: ['security', 'secure', 'vulnerab', 'injection', 'secret', 'xss', 'safe'],
    bug: ['bug', 'logic', 'error', 'crash', 'broken', 'correct'],
    performance: ['perf', 'slow', 'fast', 'latency', 'n+1', 'optimi'],
    readability: ['readab', 'style', 'clean', 'naming', 'maintain'],
  };
  let selected = ctx.findings;
  const categories = Object.entries(categoryWords)
    .filter(([, words]) => words.some((w) => q.includes(w)))
    .map(([c]) => c);
  if (categories.length) selected = selected.filter((f) => categories.includes(f.category));
  const fileMentioned = ctx.findings.map((f) => f.location.split(':')[0]!).find((p) => q.includes(p.toLowerCase()) || q.includes(p.split('/').pop()!.toLowerCase()));
  if (fileMentioned) selected = selected.filter((f) => f.location.startsWith(fileMentioned));
  selected = [...selected].sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0));

  const header = `Here is what the CodeSentinel review found for PR #${ctx.prNumber ?? '?'}${ctx.prTitle ? ` ("${ctx.prTitle}")` : ''}`;
  if (!ctx.findings.length) {
    return `${header}: no issues were reported in this pull request.${ctx.snippets.length ? ` Related code I looked at: ${[...new Set(ctx.snippets)].slice(0, 3).join(', ')}.` : ''}`;
  }
  if (!selected.length) {
    return `${header}: nothing matching your question${categories.length ? ` (${categories.join(', ')})` : ''}. There are ${ctx.findings.length} other finding(s); ask about a category such as security or performance for details.`;
  }
  const wantsFix = /\b(fix|how|suggest|resolve|change)\b/.test(q);
  const top = /\b(worst|most|critical|priorit|first|important|biggest)\b/.test(q) ? selected.slice(0, 3) : selected.slice(0, 6);
  const lines = top.map((f) => {
    const fix = wantsFix && f.suggestion ? `\n  Suggested fix: \`${f.suggestion}\`` : '';
    return `- **${f.severity.toUpperCase()}** (${f.category}) \`${f.location}\`: ${f.title}${fix}`;
  });
  const counts = selected.reduce<Record<string, number>>((acc, f) => ((acc[f.severity] = (acc[f.severity] ?? 0) + 1), acc), {});
  const summary = Object.entries(counts)
    .sort((a, b) => (SEVERITY_WEIGHT[b[0]] ?? 0) - (SEVERITY_WEIGHT[a[0]] ?? 0))
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  const advice =
    selected[0] && (SEVERITY_WEIGHT[selected[0].severity] ?? 0) >= 3
      ? 'I would address the high-severity items before merging.'
      : 'None of these are blockers, but they are worth cleaning up.';
  return `${header} — ${summary}:\n\n${lines.join('\n')}\n\n${advice}`;
}

/**
 * Offline, deterministic LLM. Review passes are answered by a heuristic analyzer through the
 * same `report_findings` tool contract as real models; chat is answered from the grounded context.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;
  readonly model = MOCK_MODEL;

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const prompt = req.messages.map((m) => m.content).join('\n');
    const inputTokens = estimateTokens(req.system) + estimateTokens(prompt);
    const tool = req.tools?.find((t) => t.name === 'report_findings');
    if (tool) {
      const pass = (/Review pass: (\w+)/.exec(req.system)?.[1] ?? 'bugs') as MockCategory;
      const tone = /Tone: (\w+)/.exec(req.system)?.[1] ?? 'neutral';
      const findings = runMockRules(pass, parseReviewPrompt(prompt), tone);
      const args = { findings };
      return {
        text: '',
        toolCalls: [{ name: tool.name, arguments: args }],
        usage: { inputTokens, outputTokens: estimateTokens(JSON.stringify(args)) + 20 },
        provider: 'mock',
        model: MOCK_MODEL,
        stopReason: 'tool_use',
      };
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const question = /Question:\s*([\s\S]*)$/.exec(lastUser)?.[1]?.trim() ?? lastUser;
    const text = mockChatAnswer(prompt, question);
    return { text, toolCalls: [], usage: { inputTokens, outputTokens: estimateTokens(text) }, provider: 'mock', model: MOCK_MODEL, stopReason: 'end_turn' };
  }
}
