# Engineering decisions

Short ADR-style notes on the trade-offs made while building CodeSentinel.

## 1. Offline-first: mock GitHub + deterministic mock LLM are the defaults
No API keys or GitHub App credentials are needed to run, seed, test or demo the project.
- `GITHUB_MODE=mock` swaps Octokit for `MockGitHubGateway`, which serves fixture repositories
  (`backend/src/fixtures/repos.ts`) and computes GitHub-style patches with the `diff` package.
  Writes (reviews, comments) are recorded in memory. Both gateways implement one `GitHubGateway`
  interface, so the review engine code path is identical.
- `LLM_PROVIDER=mock` is a heuristic analyser (~30 rules) that **parses the exact prompt** a real model
  receives and answers through the same `report_findings` tool contract. This exercises prompt
  building, tool-call parsing, validation, dedupe and posting without a network.
- The mock is priced at a simulated $0.25 / $1.25 per MTok so cost dashboards show realistic curves.
  Real providers use real list prices (`backend/src/llm/pricing.ts`).

## 2. Pluggable providers behind one interface
`LlmProvider.complete()` takes provider-neutral messages + JSON-schema tools.
- **Anthropic**: official `@anthropic-ai/sdk`, default `claude-opus-5-5`. That model rejects forced
  `tool_choice`, so tools use `tool_choice: auto` + `strict: true` and the system prompt tells the model
  to call `report_findings`. Server-side refusal fallbacks (`fallbacks: "default"`) and `output_config.effort`
  are set; a refusal becomes a typed `LlmError`.
- **OpenAI**: official SDK, strict function tools with `tool_choice: required`.
- **Gemini / Ollama**: REST via `fetch` (function declarations / `/api/chat` tools).
All providers are unit-tested against mocked HTTP.

## 3. Embeddings: 256-d pgvector with an offline hashing embedder
The index column is `vector(256)`. The default `HashingEmbedder` (signed feature hashing of code
tokens + bigrams) is deterministic and dependency-free. OpenAI embeddings request `dimensions: 256`;
Ollama vectors are folded to 256 dims and re-normalised. Changing the dimension requires a migration.
Trade-off: lexical-ish retrieval quality in offline mode, but zero model downloads in CI.

## 4. tree-sitter via WebAssembly
Native `tree-sitter` bindings need node-gyp and break across Node versions. We use `web-tree-sitter`
with prebuilt grammars from `tree-sitter-wasms`. The newest `web-tree-sitter` (0.25+) cannot load those
grammars (different emscripten dylink format), so it is pinned to **0.22.6**. Supported: TS, TSX, JS,
Python, Go, Java, Ruby, Rust. Unsupported languages fall back to ±8-line windows.

## 5. Review pipeline
1. Parse `.codesentinel.yml` from the PR head (invalid config never blocks a review; errors go into
   the summary comment).
2. Skip removed, binary, lock/vendored/generated (glob + `@generated` header + minified heuristic),
   config-ignored and oversized files.
3. tree-sitter finds the innermost function/class around each added line; its body is sent as context.
4. Related code comes from the pgvector index (first review indexes the repo at the base commit).
5. Token budget: estimate first (`chars/4`), skip with a PR notice if the monthly budget would be
   exceeded. Files are batched under `MAX_REVIEW_INPUT_TOKENS` per call.
6. Four passes (bugs, security, performance, readability) x batches run with bounded concurrency and a
   per-call timeout. A failing/timed-out pass does not fail the review; all passes failing does.
7. Model output is validated with Zod; findings for files outside the batch, past EOF or with invalid
   enums are dropped. Findings are deduped (fingerprint + same line/category), filtered by severity
   threshold and disabled rules, ranked and capped at `max_findings`.
8. Only lines on the RIGHT side of a diff hunk get inline comments (GitHub rejects others); the rest are
   listed in the summary comment.

## 6. Acceptance rate
"Acceptance" is measured two ways: (a) on `synchronize`, earlier open findings are re-checked against the
new head: if the suggestion text is now present and the flagged code is gone the finding is `accepted`,
if only the flagged code is gone it is `resolved`; (b) maintainers accept/dismiss in the dashboard.
Acceptance rate = accepted / (accepted + rejected) for findings that carried a suggestion.

## 7. Idempotency and crash safety
- Webhook deliveries are recorded by `X-GitHub-Delivery`; re-deliveries return `duplicate`.
- One automatic review per (PR, head SHA) is enforced by a unique `dedupe_key`, so concurrent deliveries
  cannot create duplicates; a re-delivery of a commit whose review failed retries it.
- Engine runs are idempotent (rows from a previous attempt are cleared first). BullMQ retries 3x with
  exponential backoff, and the worker re-enqueues reviews stuck in `queued`/`running` for longer than
  `STALE_REVIEW_MINUTES`.

## 8. Auth
GitHub OAuth web flow for real deployments; a `dev-login` endpoint (role picker) when
`AUTH_DEV_LOGIN=true` for the offline demo. Access tokens are short-lived JWTs held in memory by the SPA;
refresh tokens are random 384-bit values stored hashed, sent as an httpOnly `SameSite=Lax` cookie scoped
to `/api/auth`, rotated atomically on every use, with reuse detection revoking the whole token family.
RBAC: `viewer` (read), `maintainer` (triage, re-run, re-index), `admin` (budgets, pause, roles).

**Tenancy:** one deployment serves one organisation (the GitHub App installations it receives). All
authenticated users can read all connected repositories; there is no per-repo ACL. A multi-tenant SaaS
would scope every query by installation and map GitHub org membership to roles. This was cut for scope.

## 9. Same-origin API through the Next.js proxy
The dashboard calls `/api/*` on its own origin and Next rewrites to the backend. This avoids CORS for the
browser and lets the refresh cookie be first-party. The rewrite target is resolved at build time
(`BACKEND_INTERNAL_URL` build arg) because of Next's standalone output.

## 10. Testing strategy
Backend integration tests run against **PGlite** (in-process Postgres 16 with pgvector) with real
migrations, so SQL, constraints and vector search are exercised without Docker. `pglite` is pinned to
0.4.x, the last line that bundles the `vector` extension. BullMQ is covered by the docker-compose smoke and
e2e runs (tests use the in-process queue implementing the same interface).

## Known gaps / cut scope
- No live GitHub App was exercised (no credentials available); Octokit calls are verified against a
  mocked GitHub REST API, including real JWT -> installation-token auth with a generated RSA key.
- Suggestions are single-range replacements; multi-hunk suggestions are not generated.
- Monaco is loaded from the jsDelivr CDN by `@monaco-editor/react`; fully air-gapped deployments would
  need to self-host the Monaco assets.
- smee.io forwarding is documented, not automated.
