export type DiffLineType = 'add' | 'del' | 'context';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff patch as returned by GitHub's "list pull request files" API
 * (hunks only, no ---/+++ file headers — those are tolerated and skipped).
 */
export function parsePatch(patch: string | null | undefined): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: (m[5] ?? '').trim(),
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (!current || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('\\')) continue;
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === '+') current.lines.push({ type: 'add', content, newLine: newLine++ });
    else if (marker === '-') current.lines.push({ type: 'del', content, oldLine: oldLine++ });
    else if (marker === ' ' || raw === '') current.lines.push({ type: 'context', content, oldLine: oldLine++, newLine: newLine++ });
  }
  // A trailing empty line produced by split() is not part of the hunk.
  for (const h of hunks) {
    const last = h.lines.at(-1);
    if (last && last.type === 'context' && last.content === '' && last.newLine !== undefined && last.newLine >= h.newStart + h.newLines) {
      h.lines.pop();
    }
  }
  return hunks;
}

/** Lines on the RIGHT side of the diff that GitHub accepts review comments on. */
export function commentableLines(hunks: DiffHunk[]): Set<number> {
  const set = new Set<number>();
  for (const h of hunks) for (const l of h.lines) if (l.newLine !== undefined) set.add(l.newLine);
  return set;
}

export function addedLines(hunks: DiffHunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add'));
}

export function countChanges(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  return { additions, deletions };
}

/** Render hunks with explicit new-file line numbers so the model can cite exact lines. */
export function renderNumberedDiff(hunks: DiffHunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${h.header}`.trimEnd());
    for (const l of h.lines) {
      if (l.type === 'add') out.push(`${String(l.newLine).padStart(5)} | + ${l.content}`);
      else if (l.type === 'context') out.push(`${String(l.newLine).padStart(5)} |   ${l.content}`);
      else out.push(`      | - ${l.content}`);
    }
  }
  return out.join('\n');
}
