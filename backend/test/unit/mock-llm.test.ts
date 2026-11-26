import { describe, expect, it } from 'vitest';
import { fakeSecret } from '../../src/fixtures/fake-secrets.js';
import { codeTokens, foldVector, HashingEmbedder, l2normalize } from '../../src/embeddings/index.js';
import { MockLlmProvider, mockChatAnswer, parseReviewPrompt } from '../../src/llm/mock/provider.js';
import { runMockRules, type MockFileContext } from '../../src/llm/mock/rules.js';
import { parsePatch, renderNumberedDiff } from '../../src/parsing/diff.js';
import { DEFAULT_CONFIG } from '../../src/review/config.js';
import { buildReviewUserPrompt, buildSystemPrompt, PASSES, reportFindingsTool } from '../../src/review/prompts.js';
import { computePatch } from '../../src/github/mock-gateway.js';

function fileFrom(path: string, language: string, lines: string[]): MockFileContext {
  const added = lines.map((text, i) => ({ line: i + 1, text }));
  return { path, language, added, known: new Map(added.map((l) => [l.line, l.text])), symbols: [] };
}

const ids = (pass: Parameters<typeof runMockRules>[0], file: MockFileContext) => runMockRules(pass, [file]).map((f) => f.rule_id);

describe('mock reviewer rules', () => {
  it('flags security issues with fixes', () => {
    const file = fileFrom('a.ts', 'typescript', [
      'const rows = await db.query("SELECT * FROM users WHERE id = " + userId);',
      `const API_KEY = "${fakeSecret('stripe')}";`,
      'const data = eval(input);',
      "const h = createHash('md5').update(x).digest('hex');",
      "el.innerHTML = userHtml;",
      'const agent = new Agent({ rejectUnauthorized: false });',
      'exec(`ls ${dir}`);',
      'const token = Math.random().toString(36);',
      'fs.readFile(req.params.path, cb);',
    ]);
    const findings = runMockRules('security', [file]);
    expect(findings.map((f) => f.rule_id)).toEqual([
      'security/sql-injection',
      'security/hardcoded-secret',
      'security/code-eval',
      'security/weak-hash',
      'security/xss-inner-html',
      'security/tls-verification-disabled',
      'security/command-injection',
      'security/insecure-random',
      'security/path-traversal',
    ]);
    const byRule = Object.fromEntries(findings.map((f) => [f.rule_id, f.suggestion]));
    expect(byRule['security/sql-injection']).toBe('const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);');
    expect(byRule['security/hardcoded-secret']).toBe('const API_KEY = process.env.API_KEY;');
    expect(byRule['security/code-eval']).toBe('const data = JSON.parse(input);');
    expect(byRule['security/weak-hash']).toContain("'sha256'");
    expect(byRule['security/xss-inner-html']).toBe('el.textContent = userHtml;');
  });

  it('flags Python security and bug patterns', () => {
    const py = fileFrom('x.py', 'python', [
      'cfg = yaml.load(fh)',
      "cursor.execute(f\"SELECT * FROM runs WHERE name = '{name}'\")",
      'except:',
      'def f(a, tags=[]):',
      'requests.get(url, verify=False)',
      'TOKEN = "abcd1234efgh5678"',
    ]);
    expect(ids('security', py)).toEqual(['security/unsafe-deserialization', 'security/sql-injection', 'security/tls-verification-disabled', 'security/hardcoded-secret']);
    const sec = runMockRules('security', [py]);
    expect(sec[0]!.suggestion).toBe('cfg = yaml.safe_load(fh)');
    expect(sec[1]!.suggestion).toBe('cursor.execute("SELECT * FROM runs WHERE name = %s", (name,))');
    expect(sec[3]!.suggestion).toBe('TOKEN = os.environ["TOKEN"]');
    expect(ids('bugs', py)).toEqual(['bugs/bare-except', 'bugs/mutable-default-argument']);
  });

  it('flags bugs in JavaScript', () => {
    const file = fileFrom('b.js', 'javascript', [
      'for (let i = 0; i <= items.length; i++) {',
      'if (user = admin) {',
      'if (a == b) {}',
      '} catch (e) {}',
      'const n = parseInt(value);',
      'list.forEach(async (x) => {',
      'load().then(render);',
    ]);
    expect(ids('bugs', file)).toEqual([
      'bugs/off-by-one',
      'bugs/assignment-in-condition',
      'bugs/loose-equality',
      'bugs/empty-catch',
      'bugs/parseint-radix',
      'bugs/async-foreach',
      'bugs/floating-promise-then',
    ]);
    const fixes = runMockRules('bugs', [file]).map((f) => f.suggestion);
    expect(fixes[0]).toBe('for (let i = 0; i < items.length; i++) {');
    expect(fixes[4]).toBe('const n = parseInt(value, 10);');
  });

  it('flags performance issues using loop context', () => {
    const file = fileFrom('c.ts', 'typescript', [
      'for (const id of ids) {',
      '  const user = await getUser(id);',
      '  const match = all.find((u) => u.id === id);',
      '  const re = new RegExp(id);',
      '}',
      'const copy = JSON.parse(JSON.stringify(obj));',
      'const raw = readFileSync(path);',
      'db.query("SELECT * FROM orders");',
    ]);
    expect(ids('performance', file)).toEqual([
      'performance/await-in-loop',
      'performance/quadratic-lookup',
      'performance/regex-in-loop',
      'performance/json-deep-clone',
      'performance/sync-io',
      'performance/select-star',
    ]);
    // Not inside a loop -> no N+1 finding.
    expect(ids('performance', fileFrom('d.ts', 'typescript', ['async function f() {', '  await g();', '}']))).toEqual([]);
  });

  it('flags readability issues and long functions', () => {
    const file = fileFrom('e.ts', 'typescript', [
      'console.log(x);',
      '// TODO: remove',
      'var a = 1;',
      'function f(x: any) {}',
      'const v = a ? b : c ? d : e;',
      `const s = "${'x'.repeat(150)}";`,
    ]);
    file.symbols.push({ name: 'big', kind: 'function', startLine: 1, endLine: 90 });
    const findings = runMockRules('readability', [file], 'strict');
    expect(findings.map((f) => f.rule_id)).toEqual([
      'readability/console-log',
      'readability/todo',
      'readability/var-declaration',
      'readability/explicit-any',
      'readability/nested-ternary',
      'readability/long-line',
      'readability/long-function',
    ]);
    expect(findings[0]!.suggestion).toBe('');
    expect(findings[0]!.explanation).toMatch(/^Must fix before merge/);
  });
});

describe('MockLlmProvider', () => {
  const head = 'export function f(a) {\n  if (a == 1) return true;\n  return false;\n}\n';
  const { patch } = computePatch('src/f.ts', '', head);
  const prompt = buildReviewUserPrompt({
    repo: 'acme/x',
    prNumber: 7,
    prTitle: 'Add f',
    files: [{ path: 'src/f.ts', language: 'typescript', numberedDiff: renderNumberedDiff(parsePatch(patch)), symbols: [{ name: 'f', kind: 'function', startLine: 1, endLine: 4, code: '    1 | export function f(a) {' }] }],
    related: [{ path: 'src/g.ts', symbol: 'g', startLine: 1, endLine: 2, content: 'function g() {}' }],
  });

  it('parses the review prompt it receives', () => {
    const [file] = parseReviewPrompt(prompt);
    expect(file).toMatchObject({ path: 'src/f.ts', language: 'typescript' });
    expect(file!.added).toHaveLength(4);
    expect(file!.symbols[0]).toMatchObject({ name: 'f', startLine: 1, endLine: 4 });
  });

  it('answers review passes through the report_findings tool deterministically', async () => {
    const llm = new MockLlmProvider();
    const req = { purpose: 'review:bugs', system: buildSystemPrompt(PASSES.bugs, DEFAULT_CONFIG), messages: [{ role: 'user' as const, content: prompt }], tools: [reportFindingsTool] };
    const a = await llm.complete(req);
    const b = await llm.complete(req);
    expect(a).toEqual(b);
    expect(a.toolCalls[0]!.name).toBe('report_findings');
    const findings = (a.toolCalls[0]!.arguments as { findings: { rule_id: string; line: number }[] }).findings;
    expect(findings).toEqual([expect.objectContaining({ rule_id: 'bugs/loose-equality', line: 2 })]);
    expect(a.usage.inputTokens).toBeGreaterThan(50);
  });

  it('answers chat from grounded findings', async () => {
    const context = 'Pull request #7: Add f\n<findings>\n- [high][security] src/a.ts:3 — SQL injection || suggestion: db.query($1)\n- [low][readability] src/b.ts:9 — Debug log\n</findings>\n<snippet path="src/c.ts" lines="1-2">';
    const llm = new MockLlmProvider();
    const res = await llm.complete({ purpose: 'chat', system: 's', messages: [{ role: 'user', content: `${context}\n\nQuestion: How do I fix the security issues?` }] });
    expect(res.text).toContain('SQL injection');
    expect(res.text).toContain('Suggested fix');
    expect(res.text).not.toContain('Debug log');
    expect(mockChatAnswer(context, 'any performance problems?')).toMatch(/nothing matching/);
    expect(mockChatAnswer('Pull request #1: x\n<findings>\n</findings>', 'summary?')).toMatch(/no issues/);
    expect(mockChatAnswer(context, 'what about b.ts')).toContain('Debug log');
  });
});

describe('hashing embedder', () => {
  it('produces normalized deterministic vectors where related code is closer', async () => {
    const e = new HashingEmbedder(256);
    const [a, b, c] = await e.embed([
      'function getCustomerById(id) { return query("select * from customers where id = $1", [id]) }',
      'async function findCustomer(customerId) { return query("select * from customers", [customerId]) }',
      'export function renderChart(series) { return svg.path(series.points) }',
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(a).toHaveLength(256);
    expect(Math.abs(dot(a!, a!) - 1)).toBeLessThan(1e-9);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(await e.embed([a!.join()])).toHaveLength(1);
  });

  it('splits identifiers and folds vectors', () => {
    expect(codeTokens('getUserById snake_case_name')).toEqual(expect.arrayContaining(['getuserbyid', 'get', 'user', 'by', 'id', 'snake', 'case', 'name']));
    expect(foldVector([3, 4, 0, 0], 2)).toEqual([0.6, 0.8]);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
  });
});
