/**
 * Deterministic heuristic "reviewer" backing the offline mock LLM.
 * It reads the same prompt a real model receives and answers through the same
 * report_findings tool contract, so the whole pipeline is exercised without keys.
 */
import type { FindingSeverity } from '../../db/schema.js';

export type MockCategory = 'bugs' | 'security' | 'performance' | 'readability';

export interface MockLine {
  line: number;
  text: string;
}

export interface MockFileContext {
  path: string;
  language: string;
  added: MockLine[];
  /** Every numbered line visible to the model (diff context + symbol context). */
  known: Map<number, string>;
  symbols: { name: string; kind: string; startLine: number; endLine: number }[];
}

export interface MockFinding {
  file: string;
  line: number;
  end_line: number | null;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  suggestion: string | null;
  rule_id: string;
  confidence: number;
}

interface Rule {
  id: string;
  pass: MockCategory;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  confidence: number;
  languages?: string[];
  match: (line: MockLine, file: MockFileContext) => boolean;
  suggest?: (text: string, file: MockFileContext) => string | null;
}

const JS = ['typescript', 'tsx', 'javascript'];
const PY = ['python'];

const indentOf = (s: string) => /^\s*/.exec(s)?.[0].length ?? 0;
const isComment = (s: string) => /^\s*(\/\/|#|\*|\/\*)/.test(s);

const LOOP_RE = /^\s*(for\s*\(|for\s+\w[\w,\s]*\s+in\s+|for\s+(const|let|var)\b|while\s*\(|while\s+\w|.*\.forEach\(|.*\bfor await\b)/;

/** Is `line` nested inside a loop header that appears above it with smaller indentation? */
function insideLoop(line: MockLine, file: MockFileContext): boolean {
  const indent = indentOf(line.text);
  for (let n = line.line - 1; n >= Math.max(1, line.line - 15); n--) {
    const prev = file.known.get(n);
    if (prev === undefined || prev.trim() === '') continue;
    const prevIndent = indentOf(prev);
    if (prevIndent < indent && LOOP_RE.test(prev)) return true;
    if (prevIndent < indent && /^\s*(function|def|async|export|class|public|private|func)\b/.test(prev)) return false;
  }
  return false;
}

const toEnvName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();

function suggestSqlParam(text: string, file: MockFileContext): string | null {
  if (JS.includes(file.language)) {
    const concat = /^(.*?)(["'])([^"']*?)\2\s*\+\s*([\w.[\]]+)(\s*\+\s*(["'])\s*\6)?(.*)$/.exec(text);
    if (concat) {
      const [, pre, q, sqlPart, ident, , , rest] = concat;
      const trimmed = (sqlPart ?? '').replace(/'\s*$/, '');
      return `${pre}${q}${trimmed}$1${q}, [${ident}]${(rest ?? '').replace(/^\s*\+\s*(["'])'\1/, '')}`;
    }
    const tpl = /^(.*?)`([^`]*?)'?\$\{([^}]+)\}'?([^`]*)`(.*)$/.exec(text);
    if (tpl) {
      const [, pre, before, expr, after, rest] = tpl;
      return `${pre}'${before}$1${after}', [${expr}]${rest}`;
    }
  }
  if (PY.includes(file.language)) {
    const fstr = /^(.*?)f(["'])(.*?)'?\{([^}]+)\}'?(.*?)\2(.*)$/.exec(text);
    if (fstr) {
      const [, pre, q, before, expr, after, rest] = fstr;
      return `${pre}${q}${before}%s${after}${q}, (${expr},)${rest}`;
    }
  }
  return null;
}

const RULES: Rule[] = [
  // ---------------------------------------------------------------- security
  {
    id: 'security/sql-injection',
    pass: 'security',
    severity: 'high',
    title: 'Possible SQL injection via string-built query',
    explanation:
      'The SQL statement is assembled from untrusted input with string concatenation or interpolation. An attacker can alter the query (e.g. `1 OR 1=1`). Use parameterized queries so the driver escapes values.',
    confidence: 0.9,
    match: ({ text }) =>
      /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text) &&
      (/["']\s*\+\s*[\w.]/.test(text) || /`[^`]*\$\{[^}]+\}/.test(text) || /\bf(["'])(?:(?!\1).)*\{[^}]+\}/.test(text) || /["']\s*%\s*\(?\w/.test(text)),
    suggest: suggestSqlParam,
  },
  {
    id: 'security/hardcoded-secret',
    pass: 'security',
    severity: 'critical',
    title: 'Hardcoded secret committed to source',
    explanation:
      'A credential-like literal is embedded in code. Anything in git history is effectively public to everyone with repo access and leaks through forks and logs. Load it from the environment or a secret manager and rotate the exposed value.',
    confidence: 0.92,
    match: ({ text }) =>
      /\b\w*(api[_-]?key|secret|password|passwd|token|private[_-]?key|access[_-]?key)\w*\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i.test(text) ||
      /AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{10,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}/.test(text),
    suggest: (text, file) => {
      const m = /^(.*?\b(\w+)\b["']?\s*[:=]\s*)["'][^"']+["'](.*)$/.exec(text);
      if (!m) return null;
      const [, lhs, name, rest] = m;
      const env = toEnvName(name ?? 'SECRET');
      if (PY.includes(file.language)) return `${lhs}os.environ["${env}"]${rest}`;
      if (JS.includes(file.language)) return `${lhs}process.env.${env}${rest}`;
      return null;
    },
  },
  {
    id: 'security/code-eval',
    pass: 'security',
    severity: 'critical',
    title: 'Dynamic code execution with eval',
    explanation:
      'Evaluating strings as code lets anyone who controls the input run arbitrary code in the server process. Parse the data explicitly (e.g. JSON.parse / ast.literal_eval) instead.',
    confidence: 0.88,
    match: ({ text }) => !isComment(text) && (/(^|[^.\w])eval\s*\(/.test(text) || /new Function\s*\(/.test(text) || /(^|\s)exec\s*\(/.test(text)),
    suggest: (text, file) => {
      const simple = /(^|[^.\w])eval\(\s*([\w.]+)\s*\)/;
      if (!simple.test(text)) return null;
      if (PY.includes(file.language)) return text.replace(simple, '$1ast.literal_eval($2)');
      if (JS.includes(file.language)) return text.replace(simple, '$1JSON.parse($2)');
      return null;
    },
  },
  {
    id: 'security/unsafe-deserialization',
    pass: 'security',
    severity: 'high',
    title: 'Unsafe deserialization of untrusted data',
    explanation:
      'Deserializers such as pickle, yaml.load (without SafeLoader) and node-serialize can instantiate arbitrary objects and execute code embedded in the payload. Use a safe loader or a data-only format like JSON.',
    confidence: 0.86,
    match: ({ text }) =>
      /pickle\.loads?\(|marshal\.loads\(|\bunserialize\(|ObjectInputStream\(|serialize\.unserialize/.test(text) ||
      (/yaml\.load\(/.test(text) && !/SafeLoader|safe_load/.test(text)),
    suggest: (text) => (/yaml\.load\(/.test(text) ? text.replace(/yaml\.load\(([^,)]+)(,[^)]*)?\)/, 'yaml.safe_load($1)') : null),
  },
  {
    id: 'security/command-injection',
    pass: 'security',
    severity: 'high',
    title: 'Shell command built from variable input',
    explanation:
      'Passing interpolated strings to a shell allows command injection (`; rm -rf /`). Use execFile/spawn with an argument array (or subprocess.run([...]) without shell=True).',
    confidence: 0.85,
    match: ({ text }) =>
      /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+)/.test(text) || /os\.system\(|subprocess\.\w+\(.*shell\s*=\s*True/.test(text),
  },
  {
    id: 'security/xss-inner-html',
    pass: 'security',
    severity: 'medium',
    title: 'Unescaped HTML injection (XSS risk)',
    explanation: 'Assigning dynamic strings to innerHTML renders attacker-controlled markup and scripts. Use textContent or a sanitizer.',
    confidence: 0.8,
    languages: JS,
    match: ({ text }) => /\.innerHTML\s*=\s*(?!["']{2})/.test(text) || /dangerouslySetInnerHTML/.test(text),
    suggest: (text) => (/\.innerHTML\s*=/.test(text) ? text.replace('.innerHTML', '.textContent') : null),
  },
  {
    id: 'security/weak-hash',
    pass: 'security',
    severity: 'medium',
    title: 'Weak hash algorithm',
    explanation: 'MD5 and SHA-1 are broken for security purposes. Use SHA-256 for integrity, or bcrypt/scrypt/argon2 for passwords.',
    confidence: 0.82,
    match: ({ text }) => /createHash\(\s*["'](md5|sha1)["']\s*\)|hashlib\.(md5|sha1)\(/.test(text),
    suggest: (text) => text.replace(/(["'])(md5|sha1)\1/, '$1sha256$1').replace(/hashlib\.(md5|sha1)\(/, 'hashlib.sha256('),
  },
  {
    id: 'security/insecure-random',
    pass: 'security',
    severity: 'medium',
    title: 'Predictable randomness used for a security token',
    explanation: 'Math.random()/random.random() are not cryptographically secure; tokens derived from them can be guessed. Use crypto.randomBytes / crypto.randomUUID (or secrets in Python).',
    confidence: 0.78,
    match: ({ text }) => /(Math\.random\(\)|random\.random\(\))/.test(text) && /(token|secret|password|otp|session|nonce|key|code)/i.test(text),
  },
  {
    id: 'security/tls-verification-disabled',
    pass: 'security',
    severity: 'high',
    title: 'TLS certificate verification disabled',
    explanation: 'Disabling certificate verification exposes traffic to man-in-the-middle attacks. Keep verification on and trust the proper CA instead.',
    confidence: 0.9,
    match: ({ text }) => /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/.test(text),
    suggest: (text) => text.replace(/rejectUnauthorized\s*:\s*false/, 'rejectUnauthorized: true').replace(/verify\s*=\s*False/, 'verify=True'),
  },
  {
    id: 'security/path-traversal',
    pass: 'security',
    severity: 'high',
    title: 'File path built from request input (path traversal)',
    explanation: 'User-controlled paths like `../../etc/passwd` can escape the intended directory. Resolve against a fixed root and verify the result stays inside it.',
    confidence: 0.8,
    match: ({ text }) => /(readFile|readFileSync|createReadStream|sendFile|open)\s*\(.*\b(req|request)\.(params|query|body|args)/.test(text),
  },
  // -------------------------------------------------------------------- bugs
  {
    id: 'bugs/off-by-one',
    pass: 'bugs',
    severity: 'high',
    title: 'Off-by-one loop bound reads past the end of the array',
    explanation: 'The loop runs while `i <= length`, so the final iteration accesses index `length`, which is `undefined`. Use `<`.',
    confidence: 0.9,
    match: ({ text }) => /for\s*\(.*;\s*\w+\s*<=\s*[\w.]+\.length\s*;/.test(text),
    suggest: (text) => text.replace(/<=\s*([\w.]+\.length)/, '< $1'),
  },
  {
    id: 'bugs/assignment-in-condition',
    pass: 'bugs',
    severity: 'high',
    title: 'Assignment used inside a condition',
    explanation: 'A single `=` inside the condition assigns instead of comparing, so the branch depends on the assigned value. Use `===`.',
    confidence: 0.84,
    languages: JS,
    match: ({ text }) => /\bif\s*\(\s*[\w.]+\s*=\s*[^=>]/.test(text),
    suggest: (text) => text.replace(/(\bif\s*\(\s*[\w.]+\s*)=(\s*[^=>])/, '$1===$2'),
  },
  {
    id: 'bugs/loose-equality',
    pass: 'bugs',
    severity: 'low',
    title: 'Loose equality comparison',
    explanation: '`==` performs type coercion (`"0" == 0`, `[] == false`), a common source of subtle bugs. Use strict equality.',
    confidence: 0.7,
    languages: JS,
    match: ({ text }) => !isComment(text) && /[^=!<>]==[^=]|!=[^=]/.test(text) && !/[=!]=\s*null\b/.test(text),
    suggest: (text) => text.replace(/([^=!<>])==([^=])/g, '$1===$2').replace(/!=([^=])/g, '!==$1'),
  },
  {
    id: 'bugs/empty-catch',
    pass: 'bugs',
    severity: 'medium',
    title: 'Error silently swallowed',
    explanation: 'An empty catch block hides failures, leaving the system in an unknown state and making incidents hard to debug. Handle, log, or rethrow the error.',
    confidence: 0.83,
    languages: JS,
    match: ({ text }) => /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(text),
    suggest: (text) => {
      const name = /catch\s*\(\s*(\w+)\s*\)/.exec(text)?.[1] ?? 'error';
      return text.replace(/catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/, `catch (${name}) {\n${' '.repeat(indentOf(text) + 2)}throw ${name};\n${' '.repeat(indentOf(text))}}`);
    },
  },
  {
    id: 'bugs/bare-except',
    pass: 'bugs',
    severity: 'medium',
    title: 'Bare except catches everything, including KeyboardInterrupt',
    explanation: 'A bare `except:` also traps SystemExit and KeyboardInterrupt and hides programming errors. Catch the specific exception types you expect.',
    confidence: 0.85,
    languages: PY,
    match: ({ text }) => /^\s*except\s*:/.test(text),
    suggest: (text) => text.replace(/except\s*:/, 'except Exception:'),
  },
  {
    id: 'bugs/mutable-default-argument',
    pass: 'bugs',
    severity: 'medium',
    title: 'Mutable default argument is shared between calls',
    explanation: 'Default values are evaluated once at definition time, so the same list/dict is reused (and mutated) across calls. Default to None and create it inside.',
    confidence: 0.88,
    languages: PY,
    match: ({ text }) => /def \w+\(.*=\s*(\[\]|\{\})/.test(text),
    suggest: (text) => text.replace(/=\s*(\[\]|\{\})/g, '=None'),
  },
  {
    id: 'bugs/parseint-radix',
    pass: 'bugs',
    severity: 'low',
    title: 'parseInt without an explicit radix',
    explanation: 'Without a radix, inputs such as "0x1A" are parsed as hex. Always pass 10 for decimal input.',
    confidence: 0.66,
    languages: JS,
    match: ({ text }) => /parseInt\(\s*[^,()]+\s*\)/.test(text),
    suggest: (text) => text.replace(/parseInt\(\s*([^,()]+?)\s*\)/, 'parseInt($1, 10)'),
  },
  {
    id: 'bugs/async-foreach',
    pass: 'bugs',
    severity: 'medium',
    title: 'async callback passed to forEach is not awaited',
    explanation: 'Array.prototype.forEach ignores returned promises, so the function continues before the work completes and rejections become unhandled. Use for...of with await, or Promise.all with map.',
    confidence: 0.86,
    languages: JS,
    match: ({ text }) => /\.forEach\(\s*async\b/.test(text),
  },
  {
    id: 'bugs/floating-promise-then',
    pass: 'bugs',
    severity: 'low',
    title: 'Promise chain without a rejection handler',
    explanation: 'A `.then()` chain with no `.catch()` produces an unhandled rejection when it fails, which crashes Node by default.',
    confidence: 0.6,
    languages: JS,
    match: ({ text }) => /\.then\(/.test(text) && !/\.catch\(|await|return/.test(text),
  },
  // ------------------------------------------------------------- performance
  {
    id: 'performance/await-in-loop',
    pass: 'performance',
    severity: 'medium',
    title: 'Sequential await inside a loop (N+1)',
    explanation: 'Each iteration waits for the previous request to finish, so latency grows linearly with the collection size. Batch the work or run it concurrently with Promise.all (with a concurrency limit if needed).',
    confidence: 0.8,
    languages: [...JS, ...PY],
    match: (line, file) => /\bawait\b/.test(line.text) && !/Promise\.all/.test(line.text) && insideLoop(line, file),
  },
  {
    id: 'performance/quadratic-lookup',
    pass: 'performance',
    severity: 'medium',
    title: 'Linear search inside a loop (O(n·m))',
    explanation: 'Calling find/filter/includes/indexOf on an array inside a loop scans the whole array per iteration. Build a Map or Set once before the loop for O(1) lookups.',
    confidence: 0.74,
    languages: JS,
    match: (line, file) => /\.(find|filter|includes|indexOf|some)\(/.test(line.text) && insideLoop(line, file),
  },
  {
    id: 'performance/json-deep-clone',
    pass: 'performance',
    severity: 'low',
    title: 'Deep clone via JSON round-trip',
    explanation: 'JSON.parse(JSON.stringify(x)) is slow, drops Dates/Maps/undefined and fails on cycles. Use structuredClone().',
    confidence: 0.82,
    languages: JS,
    match: ({ text }) => /JSON\.parse\(\s*JSON\.stringify\(/.test(text),
    suggest: (text) => text.replace(/JSON\.parse\(\s*JSON\.stringify\(([^()]+)\)\s*\)/, 'structuredClone($1)'),
  },
  {
    id: 'performance/sync-io',
    pass: 'performance',
    severity: 'medium',
    title: 'Blocking synchronous I/O',
    explanation: 'Synchronous filesystem/process calls block the event loop for every concurrent request. Use the async (promises) variants on request paths.',
    confidence: 0.72,
    languages: JS,
    match: ({ text }, file) => /\b(readFileSync|writeFileSync|execSync|readdirSync)\(/.test(text) && !/(^|\/)(scripts|config|bin)\//.test(file.path),
  },
  {
    id: 'performance/select-star',
    pass: 'performance',
    severity: 'low',
    title: 'Unbounded SELECT * query',
    explanation: 'Selecting every column transfers unused data and breaks when the schema changes; without a LIMIT it can load entire tables. Select the needed columns and paginate.',
    confidence: 0.65,
    match: ({ text }) => /SELECT\s+\*\s+FROM/i.test(text) && !/LIMIT/i.test(text),
  },
  {
    id: 'performance/regex-in-loop',
    pass: 'performance',
    severity: 'low',
    title: 'Regular expression compiled inside a loop',
    explanation: 'Constructing a RegExp on every iteration repeats compilation work. Hoist it outside the loop.',
    confidence: 0.7,
    match: (line, file) => /new RegExp\(|re\.compile\(/.test(line.text) && insideLoop(line, file),
  },
  // ------------------------------------------------------------- readability
  {
    id: 'readability/console-log',
    pass: 'readability',
    severity: 'low',
    title: 'Leftover debug logging',
    explanation: 'Debug output pollutes logs and can leak sensitive data. Remove it or use the structured logger at an appropriate level.',
    confidence: 0.75,
    match: ({ text }, file) =>
      (JS.includes(file.language) && /console\.(log|debug)\(/.test(text)) ||
      (PY.includes(file.language) && /^\s*print\(/.test(text) && !/(^|\/)(scripts|cli)\//.test(file.path)),
    suggest: () => '',
  },
  {
    id: 'readability/todo',
    pass: 'readability',
    severity: 'info',
    title: 'Unresolved TODO/FIXME',
    explanation: 'Track follow-up work in the issue tracker and reference it, so it does not silently rot in the code.',
    confidence: 0.6,
    match: ({ text }) => /\b(TODO|FIXME|HACK|XXX)\b/.test(text),
  },
  {
    id: 'readability/var-declaration',
    pass: 'readability',
    severity: 'low',
    title: 'Use let/const instead of var',
    explanation: '`var` is function-scoped and hoisted, which causes surprising bugs in closures and loops. Prefer const (or let when reassigned).',
    confidence: 0.8,
    languages: JS,
    match: ({ text }) => /^\s*var\s+/.test(text),
    suggest: (text) => text.replace(/^(\s*)var\s+/, '$1let '),
  },
  {
    id: 'readability/explicit-any',
    pass: 'readability',
    severity: 'low',
    title: 'Explicit `any` disables type checking',
    explanation: '`any` silently opts out of the type system and spreads through inference. Use a concrete type, a generic, or `unknown` with narrowing.',
    confidence: 0.7,
    languages: ['typescript', 'tsx'],
    match: ({ text }) => /:\s*any\b|<any>|\bas any\b|any\[\]/.test(text),
    suggest: (text) => text.replace(/:\s*any\b/, ': unknown'),
  },
  {
    id: 'readability/nested-ternary',
    pass: 'readability',
    severity: 'low',
    title: 'Nested ternary is hard to read',
    explanation: 'Chained conditional expressions are difficult to scan and easy to get wrong. Use if/else or a lookup table.',
    confidence: 0.68,
    match: ({ text }) => /\?[^:?]+:[^?;]*\?[^:]+:/.test(text),
  },
  {
    id: 'readability/long-line',
    pass: 'readability',
    severity: 'info',
    title: 'Very long line',
    explanation: 'Lines over 140 characters are hard to review side-by-side. Break the expression up.',
    confidence: 0.55,
    match: ({ text }) => text.length > 140,
  },
];

export const MOCK_RULE_IDS = RULES.map((r) => r.id);

const TONE_PREFIX: Record<string, string> = {
  friendly: 'Nice progress here! One thing worth a look: ',
  neutral: '',
  strict: 'Must fix before merge: ',
};

export function runMockRules(pass: MockCategory, files: MockFileContext[], tone = 'neutral'): MockFinding[] {
  const out: MockFinding[] = [];
  for (const file of files) {
    for (const added of file.added) {
      for (const rule of RULES) {
        if (rule.pass !== pass) continue;
        if (rule.languages && !rule.languages.includes(file.language)) continue;
        if (!rule.match(added, file)) continue;
        const suggestion = rule.suggest ? rule.suggest(added.text, file) : null;
        out.push({
          file: file.path,
          line: added.line,
          end_line: null,
          severity: rule.severity,
          title: rule.title,
          explanation: `${TONE_PREFIX[tone] ?? ''}${rule.explanation}`,
          suggestion: suggestion !== null && suggestion !== added.text ? suggestion : null,
          rule_id: rule.id,
          confidence: rule.confidence,
        });
        break; // one finding per line per pass keeps output focused
      }
    }
    if (pass === 'readability') {
      for (const s of file.symbols) {
        const length = s.endLine - s.startLine + 1;
        if (s.kind !== 'class' && s.kind !== 'block' && length > 60) {
          out.push({
            file: file.path,
            line: s.startLine,
            end_line: null,
            severity: 'low',
            title: `\`${s.name}\` is ${length} lines long`,
            explanation: `${TONE_PREFIX[tone] ?? ''}Long functions mix several responsibilities and are hard to test. Extract cohesive steps into well-named helpers.`,
            suggestion: null,
            rule_id: 'readability/long-function',
            confidence: 0.6,
          });
        }
      }
    }
  }
  return out;
}
