import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type SupportedLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java' | 'ruby' | 'rust';

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'module' | 'block';
  startLine: number;
  endLine: number;
  /** Nesting depth (0 = top level). */
  depth: number;
}

const EXTENSIONS: Record<string, SupportedLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  rs: 'rust',
};

/** Display language for files tree-sitter does not parse (used by the dashboard diff viewer). */
const OTHER_LANGUAGES: Record<string, string> = {
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  sh: 'shell',
  toml: 'toml',
  kt: 'kotlin',
  php: 'php',
  cs: 'csharp',
};

export function detectLanguage(path: string): SupportedLanguage | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS[ext];
}

export function displayLanguage(path: string): string {
  const lang = detectLanguage(path);
  if (lang) return lang === 'tsx' ? 'typescript' : lang;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return OTHER_LANGUAGES[ext] ?? 'plaintext';
}

type SymbolKind = CodeSymbol['kind'];

/** tree-sitter node types that define a named scope, per grammar. */
const SYMBOL_NODES: Record<SupportedLanguage, Record<string, SymbolKind>> = {
  typescript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    interface_declaration: 'interface',
    arrow_function: 'function',
    function_expression: 'function',
  },
  tsx: {},
  javascript: {
    function_declaration: 'function',
    generator_function_declaration: 'function',
    method_definition: 'method',
    class_declaration: 'class',
    arrow_function: 'function',
    function_expression: 'function',
  },
  python: { function_definition: 'function', class_definition: 'class' },
  go: { function_declaration: 'function', method_declaration: 'method', type_declaration: 'type' },
  java: {
    method_declaration: 'method',
    constructor_declaration: 'method',
    class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'type',
  },
  ruby: { method: 'method', singleton_method: 'method', class: 'class', module: 'module' },
  rust: { function_item: 'function', impl_item: 'class', struct_item: 'type', trait_item: 'interface', enum_item: 'type' },
};
SYMBOL_NODES.tsx = SYMBOL_NODES.typescript;

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedLanguage, Promise<Parser.Language | null>>();

async function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function loadLanguage(lang: SupportedLanguage): Promise<Parser.Language | null> {
  let cached = languageCache.get(lang);
  if (!cached) {
    cached = (async () => {
      try {
        await ensureInit();
        const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`);
        return await Parser.Language.load(wasm);
      } catch {
        return null;
      }
    })();
    languageCache.set(lang, cached);
  }
  return cached;
}

function nodeName(node: Parser.SyntaxNode): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct) return direct.text;
  // Anonymous functions assigned to a variable / property / object key take that name.
  const parent = node.parent;
  if (!parent) return undefined;
  if (parent.type === 'variable_declarator') return parent.childForFieldName('name')?.text;
  if (parent.type === 'pair') return parent.childForFieldName('key')?.text;
  if (parent.type === 'assignment_expression') return parent.childForFieldName('left')?.text;
  if (parent.type === 'public_field_definition' || parent.type === 'field_definition') return parent.childForFieldName('name')?.text;
  if (node.type === 'impl_item') return node.childForFieldName('type')?.text;
  if (node.type === 'type_declaration') return node.namedChildren[0]?.childForFieldName('name')?.text;
  return undefined;
}

/**
 * Extract named functions/classes/methods from source using tree-sitter.
 * Returns `null` when the language is unsupported or the grammar fails to load.
 */
export async function extractSymbols(source: string, path: string): Promise<CodeSymbol[] | null> {
  const lang = detectLanguage(path);
  if (!lang) return null;
  const language = await loadLanguage(lang);
  if (!language) return null;

  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const kinds = SYMBOL_NODES[lang];
  const symbols: CodeSymbol[] = [];

  const walk = (node: Parser.SyntaxNode, depth: number) => {
    let nextDepth = depth;
    const kind = kinds[node.type];
    if (kind) {
      const name = nodeName(node);
      // Skip anonymous callbacks (e.g. `.map(x => ...)`) — they are context, not symbols.
      if (name) {
        symbols.push({ name, kind, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, depth });
        nextDepth = depth + 1;
      }
    }
    for (const child of node.namedChildren) walk(child, nextDepth);
  };
  walk(tree.rootNode, 0);
  tree.delete();
  parser.delete();
  return symbols;
}

/** Innermost symbol containing each changed line; lines outside any symbol get a ±window block. */
export function enclosingSymbols(symbols: CodeSymbol[], lines: number[], totalLines: number, window = 8): CodeSymbol[] {
  const result = new Map<string, CodeSymbol>();
  const orphan: number[] = [];
  for (const line of lines) {
    let best: CodeSymbol | undefined;
    for (const s of symbols) {
      if (s.startLine <= line && line <= s.endLine && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) best = s;
    }
    if (best) result.set(`${best.name}:${best.startLine}`, best);
    else orphan.push(line);
  }
  // Merge orphan lines into contiguous context blocks.
  orphan.sort((a, b) => a - b);
  let block: CodeSymbol | undefined;
  for (const line of orphan) {
    const start = Math.max(1, line - window);
    const end = Math.min(totalLines, line + window);
    if (block && start <= block.endLine + 1) block.endLine = Math.max(block.endLine, end);
    else {
      block = { name: `lines ${start}-${end}`, kind: 'block', startLine: start, endLine: end, depth: 0 };
      result.set(`block:${start}`, block);
    }
    block.name = `lines ${block.startLine}-${block.endLine}`;
  }
  return [...result.values()].sort((a, b) => a.startLine - b.startLine);
}

export function sliceLines(source: string, startLine: number, endLine: number, numbered = true): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = startLine; i <= Math.min(endLine, lines.length); i++) {
    out.push(numbered ? `${String(i).padStart(5)} | ${lines[i - 1]}` : (lines[i - 1] ?? ''));
  }
  return out.join('\n');
}
