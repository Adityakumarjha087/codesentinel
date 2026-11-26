import { describe, expect, it } from 'vitest';
import { addedLines, commentableLines, countChanges, parsePatch, renderNumberedDiff } from '../../src/parsing/diff.js';
import { detectLanguage, displayLanguage, enclosingSymbols, extractSymbols, sliceLines } from '../../src/parsing/treesitter.js';
import { computePatch } from '../../src/github/mock-gateway.js';

const PATCH = `@@ -1,4 +1,6 @@ export function a()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
@@ -10,2 +12,3 @@
 line10
+added12
 line11`;

describe('parsePatch', () => {
  it('parses hunks with correct old/new line numbers', () => {
    const hunks = parsePatch(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, newLines: 6, header: 'export function a()' });
    expect(addedLines(hunks).map((l) => [l.newLine, l.content])).toEqual([
      [2, 'const b = 3;'],
      [3, 'const c = 4;'],
      [13, 'added12'],
    ]);
    expect(countChanges(hunks)).toEqual({ additions: 3, deletions: 1 });
  });

  it('computes commentable RIGHT-side lines (added + context)', () => {
    const lines = commentableLines(parsePatch(PATCH));
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 12, 13, 14]);
  });

  it('handles empty and header-only patches', () => {
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch('--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+hello')).toHaveLength(1);
  });

  it('renders numbered diffs the model can cite', () => {
    const out = renderNumberedDiff(parsePatch(PATCH));
    expect(out).toContain('    2 | + const b = 3;');
    expect(out).toContain('      | - const b = 2;');
    expect(out).toContain('    1 |   const a = 1;');
  });

  it('round-trips patches computed from file versions', () => {
    const { patch, additions, deletions } = computePatch('x.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(additions).toBe(2);
    expect(deletions).toBe(1);
    expect(addedLines(parsePatch(patch)).map((l) => l.newLine)).toEqual([2, 4]);
  });
});

describe('tree-sitter symbols', () => {
  const ts = `import x from 'y';

export class Service {
  run(a: number) {
    return a + 1;
  }
}

export const handler = async (req: Request) => {
  return new Response('ok');
};

function helper() {
  [1, 2].map((n) => n * 2);
}
`;

  it('extracts classes, methods and named arrow functions from TypeScript', async () => {
    const symbols = await extractSymbols(ts, 'src/service.ts');
    expect(symbols?.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`)).toEqual([
      'class:Service:3-7',
      'method:run:4-6',
      'function:handler:9-11',
      'function:helper:13-15',
    ]);
  });

  it('extracts Python functions and classes', async () => {
    const py = 'class A:\n    def m(self):\n        return 1\n\n\ndef f(x):\n    return x\n';
    const symbols = await extractSymbols(py, 'a.py');
    expect(symbols?.map((s) => s.name)).toEqual(['A', 'm', 'f']);
  });

  it('extracts Go and Java symbols', async () => {
    const go = 'package main\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n';
    expect((await extractSymbols(go, 'main.go'))?.[0]).toMatchObject({ name: 'Add', kind: 'function' });
    const java = 'class Foo {\n  int bar() { return 1; }\n}\n';
    expect((await extractSymbols(java, 'Foo.java'))?.map((s) => s.name)).toEqual(['Foo', 'bar']);
  });

  it('returns null for unsupported languages', async () => {
    expect(await extractSymbols('a: 1', 'config.yaml')).toBeNull();
    expect(detectLanguage('x.unknown')).toBeUndefined();
    expect(displayLanguage('x.yml')).toBe('yaml');
    expect(displayLanguage('x.tsx')).toBe('typescript');
    expect(displayLanguage('x.zzz')).toBe('plaintext');
  });

  it('finds the innermost enclosing symbol and windows orphan lines', async () => {
    const symbols = (await extractSymbols(ts, 'src/service.ts'))!;
    const result = enclosingSymbols(symbols, [5, 1], 16, 2);
    expect(result.map((s) => s.name)).toEqual(['lines 1-3', 'run']);
  });

  it('slices numbered source lines', () => {
    expect(sliceLines('a\nb\nc', 2, 3)).toBe('    2 | b\n    3 | c');
    expect(sliceLines('a\nb\nc', 1, 1, false)).toBe('a');
  });
});
