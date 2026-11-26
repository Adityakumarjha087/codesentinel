#!/usr/bin/env bash
# End-to-end sample run of every major CodeSentinel feature against a running stack
# (docker compose up -d). Requires: curl, jq, openssl.
#
#   ./scripts/smoke.sh                       # defaults to http://localhost:20301 / :20300
#   API=http://localhost:20301 WEB=http://localhost:20300 ./scripts/smoke.sh
set -euo pipefail

API="${API:-http://localhost:20301}"
WEB="${WEB:-http://localhost:20300}"
SECRET="${GITHUB_WEBHOOK_SECRET:-codesentinel-dev-webhook-secret}"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

pass=0
fail=0
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
ko() { fail=$((fail + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check() { if [ "$1" = "$2" ]; then ok "$3 ($1)"; else ko "$3 (expected $2, got $1)"; fi; }
sha1() { printf '%s' "$1" | openssl dgst -sha1 -r | cut -d' ' -f1; }
sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1; }

step "1. Health, OpenAPI docs and dashboard"
health=$(curl -fsS "$API/api/health")
check "$(jq -r .status <<<"$health")" ok "API health"
echo "  checks=$(jq -c .checks <<<"$health") llm=$(jq -c .llm <<<"$health") queue=$(jq -r .queue <<<"$health") github=$(jq -r .github <<<"$health")"
check "$(curl -s -o /dev/null -w '%{http_code}' "$API/docs/json")" 200 "OpenAPI spec at /docs"
check "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/login")" 200 "Dashboard login page"
check "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/api/health")" 200 "Dashboard /api proxy to backend"

step "2. Auth: demo login, refresh rotation, RBAC"
login=$(curl -fsS -c "$COOKIES" -H 'content-type: application/json' -d '{"login":"smoke-admin","role":"admin"}' "$API/api/auth/dev-login")
TOKEN=$(jq -r .accessToken <<<"$login")
check "$(jq -r .user.role <<<"$login")" admin "dev login as admin"
AUTH=(-H "authorization: Bearer $TOKEN")
check "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/repos")" 401 "unauthenticated request rejected"
refresh_code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -c "$COOKIES" -X POST "$API/api/auth/refresh")
check "$refresh_code" 200 "refresh token rotation"
viewer=$(curl -fsS -H 'content-type: application/json' -d '{"login":"smoke-viewer","role":"viewer"}' "$API/api/auth/dev-login" | jq -r .accessToken)
check "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $viewer" "$API/api/users")" 403 "viewer blocked from admin endpoint"

step "3. Signed pull_request webhook -> queue -> multi-pass review"
payload=$(jq -cn --arg head "$(sha1 'acme:payments-api:142:head')" --arg base "$(sha1 'acme:payments-api:base')" '{
  action: "opened", number: 142,
  pull_request: { number: 142, title: "Partner webhook signature verification", html_url: "https://github.com/acme/payments-api/pull/142",
    state: "open", draft: false, user: { login: "marco-p" }, head: { sha: $head, ref: "feature/partner-webhooks" }, base: { sha: $base, ref: "main" } },
  repository: { id: 700001, name: "payments-api", full_name: "acme/payments-api", private: true, default_branch: "main", owner: { login: "acme" } },
  installation: { id: 9100 } }')
bad=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'x-github-event: pull_request' -H 'x-hub-signature-256: sha256=deadbeef' -d "$payload" "$API/api/webhooks/github")
check "$bad" 401 "forged signature rejected"
hook=$(curl -fsS -H 'content-type: application/json' -H 'x-github-event: pull_request' -H "x-github-delivery: smoke-$(date +%s)" \
  -H "x-hub-signature-256: sha256=$(sign "$payload")" -d "$payload" "$API/api/webhooks/github")
REVIEW=$(jq -r .reviewId <<<"$hook")
echo "  webhook -> $(jq -c . <<<"$hook")"
[ -n "$REVIEW" ] && [ "$REVIEW" != null ] && ok "review queued ($REVIEW)" || ko "no review id"
status=queued
for _ in $(seq 1 60); do
  status=$(curl -fsS "${AUTH[@]}" "$API/api/reviews/$REVIEW" | jq -r .review.status)
  [ "$status" = completed ] || [ "$status" = failed ] || [ "$status" = skipped ] && break
  sleep 1
done
check "$status" completed "worker completed the review"
detail=$(curl -fsS "${AUTH[@]}" "$API/api/reviews/$REVIEW")
nfind=$(jq '.findings | length' <<<"$detail")
[ "$nfind" -gt 0 ] && ok "findings stored: $nfind" || ko "no findings"
echo "  passes=$(jq -c .review.passes <<<"$detail") tokens=$(jq '.review.inputTokens + .review.outputTokens' <<<"$detail") cost=\$$(jq .review.costUsd <<<"$detail") model=$(jq -r .review.model <<<"$detail")"
jq -r '.findings | sort_by(.line)[] | "    [\(.severity)] \(.category) \(.filePath):\(.line) \(.ruleId)  suggestion=\(.suggestion != null)"' <<<"$detail"
check "$(jq '[.findings[] | select(.category=="security")] | length > 0' <<<"$detail")" true "security pass found issues"
check "$(jq '.review.githubReviewId != null and .review.summaryCommentId != null' <<<"$detail")" true "inline review + summary comment posted (mock GitHub)"
check "$(jq '.files[0].symbols | length > 0' <<<"$detail")" true "tree-sitter located changed functions"
dup=$(curl -fsS -H 'content-type: application/json' -H 'x-github-event: pull_request' -H "x-github-delivery: smoke-dup-$(date +%s)" \
  -H "x-hub-signature-256: sha256=$(sign "$payload")" -d "$payload" "$API/api/webhooks/github" | jq -r .status)
check "$dup" duplicate "same commit is not reviewed twice"

step "4. Finding triage (acceptance tracking)"
FID=$(jq -r '[.findings[] | select(.suggestion != null)][0].id' <<<"$detail")
check "$(curl -fsS "${AUTH[@]}" -X PATCH -H 'content-type: application/json' -d '{"status":"accepted"}' "$API/api/findings/$FID" | jq -r .status)" accepted "accept a suggestion"
check "$(curl -fsS "${AUTH[@]}" -X PATCH -H 'content-type: application/json' -d '{"status":"open"}' "$API/api/findings/$FID" | jq -r .status)" open "reopen it"

step "5. Chat with the PR"
PR=$(jq -r .pullRequest.id <<<"$detail")
answer=$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -d '{"message":"Which security issues should I fix first?"}' "$API/api/pull-requests/$PR/chat")
echo "$answer" | jq -r .answer.content | sed 's/^/    /' | head -8
check "$(jq '.answer.content | test("eval|TLS|hash")' <<<"$answer")" true "grounded chat answer"

step "6. Dashboard analytics, repositories, token budgets"
stats=$(curl -fsS "${AUTH[@]}" "$API/api/stats/overview?days=30")
echo "  reviews=$(jq .reviews.total <<<"$stats") findings=$(jq .findings.total <<<"$stats") acceptanceRate=$(jq .acceptanceRate <<<"$stats") tokens=$(jq .usage.tokens <<<"$stats") cost=\$$(jq .usage.costUsd <<<"$stats")"
echo "  byCategory=$(jq -c '[.byCategory[] | {(.category): .count}] | add' <<<"$stats")"
check "$(jq '.timeline | length' <<<"$stats")" 30 "30-day timeline"
repos=$(curl -fsS "${AUTH[@]}" "$API/api/repos")
jq -r '.[] | "    \(.fullName): reviews=\(.reviewCount) open=\(.openFindings) tokens=\(.tokensThisMonth)/\(.monthlyTokenBudget) cost=$\(.costThisMonth)"' <<<"$repos"
RID=$(jq -r '.[] | select(.fullName=="acme/payments-api") | .id' <<<"$repos")
check "$(curl -fsS "${AUTH[@]}" -X PATCH -H 'content-type: application/json' -d '{"monthlyTokenBudget":3000000}' "$API/api/repos/$RID" | jq .monthlyTokenBudget)" 3000000 "admin updates token budget"
check "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST "$API/api/repos/$RID/reindex")" 202 "re-index repository embeddings"

step "7. Validation and error handling"
check "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/reviews/not-a-uuid")" 400 "invalid UUID -> 400"
check "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/reviews/00000000-0000-0000-0000-000000000000")" 404 "unknown id -> 404"
check "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/api/reviews?pageSize=1000")" 400 "pagination bound -> 400"
check "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -H 'content-type: application/json' -d '{"message":"   "}' "$API/api/pull-requests/$PR/chat")" 400 "blank chat message -> 400"

printf '\n\033[1mSmoke test: %d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
