import { and, cosineDistance, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { codeChunks, repositories, type Repository } from '../db/schema.js';
import type { Embedder } from '../embeddings/index.js';
import type { GitHubGateway } from '../github/types.js';
import type { Logger } from '../lib/logger.js';
import { createIgnoreMatcher, DEFAULT_IGNORES, looksGenerated } from '../review/config.js';
import { detectLanguage, extractSymbols, type CodeSymbol } from '../parsing/treesitter.js';

export interface Chunk {
  path: string;
  symbol: string | null;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
}

const MAX_CHUNK_LINES = 120;
const WINDOW = 60;
const OVERLAP = 10;
const MAX_CHUNK_CHARS = 4000;
const MAX_FILE_BYTES = 200_000;

function windowChunks(path: string, lines: string[], from = 1, to = lines.length): Chunk[] {
  const out: Chunk[] = [];
  for (let start = from; start <= to; start += WINDOW - OVERLAP) {
    const end = Math.min(to, start + WINDOW - 1);
    const content = lines.slice(start - 1, end).join('\n');
    if (content.trim()) out.push({ path, symbol: null, kind: 'block', startLine: start, endLine: end, content: content.slice(0, MAX_CHUNK_CHARS) });
    if (end >= to) break;
  }
  return out;
}

/** Chunk a file along tree-sitter symbol boundaries (falls back to sliding windows). */
export async function chunkFile(path: string, source: string): Promise<Chunk[]> {
  const lines = source.split('\n');
  const symbols = await extractSymbols(source, path);
  if (!symbols || symbols.length === 0) return windowChunks(path, lines);

  const chosen: CodeSymbol[] = [];
  const consider = (s: CodeSymbol) => {
    const length = s.endLine - s.startLine + 1;
    if (length <= MAX_CHUNK_LINES) {
      chosen.push(s);
      return;
    }
    const children = symbols.filter((c) => c.depth === s.depth + 1 && c.startLine >= s.startLine && c.endLine <= s.endLine);
    if (children.length) children.forEach(consider);
    else chosen.push({ ...s, endLine: s.startLine + MAX_CHUNK_LINES - 1 });
  };
  symbols.filter((s) => s.depth === 0).forEach(consider);

  const chunks: Chunk[] = chosen.map((s) => ({
    path,
    symbol: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    content: lines.slice(s.startLine - 1, s.endLine).join('\n').slice(0, MAX_CHUNK_CHARS),
  }));
  // Module-level code outside any symbol (imports, constants) as one header chunk.
  const covered = new Set<number>();
  for (const s of chosen) for (let i = s.startLine; i <= s.endLine; i++) covered.add(i);
  const header = lines
    .map((text, i) => ({ text, n: i + 1 }))
    .filter((l) => !covered.has(l.n) && l.text.trim())
    .slice(0, 40);
  if (header.length) {
    chunks.unshift({
      path,
      symbol: null,
      kind: 'module',
      startLine: header[0]!.n,
      endLine: header.at(-1)!.n,
      content: header.map((l) => l.text).join('\n').slice(0, MAX_CHUNK_CHARS),
    });
  }
  return chunks;
}


export interface IndexResult {
  files: number;
  chunks: number;
}

export class RepositoryIndexer {
  constructor(
    private readonly db: Database,
    private readonly gateway: GitHubGateway,
    private readonly embedder: Embedder,
    private readonly logger: Logger,
    private readonly maxFiles = 400,
  ) {}

  /** (Re)build the embedding index of a repository at `gitRef`. */
  async indexRepository(repo: Repository, gitRef: string): Promise<IndexResult> {
    const ref = { installationId: repo.installationId, owner: repo.owner, repo: repo.name };
    const ignored = createIgnoreMatcher(DEFAULT_IGNORES);
    const candidates = (await this.gateway.listFiles(ref, gitRef))
      .filter((f) => detectLanguage(f.path) && !ignored(f.path) && f.size <= MAX_FILE_BYTES)
      .slice(0, this.maxFiles);

    const chunks: Chunk[] = [];
    for (const file of candidates) {
      const content = await this.gateway.getFileContent(ref, file.path, gitRef);
      if (!content || looksGenerated(content)) continue;
      chunks.push(...(await chunkFile(file.path, content)));
    }
    await this.replaceChunks(repo.id, chunks, null);
    await this.db.update(repositories).set({ indexedSha: gitRef, indexedAt: new Date() }).where(eq(repositories.id, repo.id));
    this.logger.info({ repo: repo.fullName, files: candidates.length, chunks: chunks.length }, 'repository indexed');
    return { files: candidates.length, chunks: chunks.length };
  }

  /** Incrementally refresh the chunks of specific files (e.g. files changed by a merged PR). */
  async indexFiles(repo: Repository, files: { path: string; content: string | null }[]): Promise<number> {
    const chunks: Chunk[] = [];
    for (const f of files) if (f.content && detectLanguage(f.path) && !looksGenerated(f.content)) chunks.push(...(await chunkFile(f.path, f.content)));
    await this.replaceChunks(
      repo.id,
      chunks,
      files.map((f) => f.path),
    );
    return chunks.length;
  }

  private async replaceChunks(repoId: string, chunks: Chunk[], onlyPaths: string[] | null): Promise<void> {
    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += 64) {
      const batch = chunks.slice(i, i + 64);
      embeddings.push(...(await this.embedder.embed(batch.map((c) => `${c.path}\n${c.symbol ?? ''}\n${c.content}`))));
    }
    await this.db.transaction(async (tx) => {
      if (onlyPaths === null) await tx.delete(codeChunks).where(eq(codeChunks.repoId, repoId));
      else if (onlyPaths.length) await tx.delete(codeChunks).where(and(eq(codeChunks.repoId, repoId), inArray(codeChunks.path, onlyPaths)));
      for (let i = 0; i < chunks.length; i += 100) {
        const rows = chunks.slice(i, i + 100).map((c, j) => ({ repoId, ...c, embedding: embeddings[i + j]! }));
        if (rows.length) await tx.insert(codeChunks).values(rows);
      }
    });
  }

  /** Nearest code chunks by cosine similarity, excluding the files under review. */
  async search(repoId: string, text: string, opts: { k?: number; excludePaths?: string[]; minScore?: number } = {}) {
    const [embedding] = await this.embedder.embed([text]);
    if (!embedding) return [];
    const distance = cosineDistance(codeChunks.embedding, embedding);
    const conditions = [eq(codeChunks.repoId, repoId)];
    if (opts.excludePaths?.length) conditions.push(notInArray(codeChunks.path, opts.excludePaths));
    const rows = await this.db
      .select({
        path: codeChunks.path,
        symbol: codeChunks.symbol,
        kind: codeChunks.kind,
        startLine: codeChunks.startLine,
        endLine: codeChunks.endLine,
        content: codeChunks.content,
        score: sql<number>`1 - (${distance})`,
      })
      .from(codeChunks)
      .where(and(...conditions))
      .orderBy(distance)
      .limit(opts.k ?? 3);
    return rows.map((r) => ({ ...r, score: Number(r.score) })).filter((r) => r.score >= (opts.minScore ?? 0.05));
  }
}
