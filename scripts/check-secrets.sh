#!/usr/bin/env bash
# CI guard: fail if a real secret pattern appears in any tracked file.
#
# .env is intentionally tracked (Lovable-managed; contains only public-by-design
# values: publishable/anon key, project URL/id — operator decision 2026-07-05).
# This guard is the compensating control: the moment a service-role key, API
# secret, or private key lands anywhere tracked, CI fails.
set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0

scan() {
  local label="$1" pattern="$2"
  # Tracked text files only; exclude this guard and lockfiles.
  local hits
  hits=$(git grep -nIE "$pattern" -- \
    ':!scripts/check-secrets.sh' \
    ':!package-lock.json' ':!bun.lockb' ':!bun.lock' \
    2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "❌ $label:"
    echo "$hits"
    FAIL=1
  fi
}

# Supabase service_role JWT: legacy JWTs carry the role claim in the payload.
# "service_role" can start at any byte offset within the payload, so its base64
# encoding takes one of three phase-shifted forms depending on offset mod 3.
# Matching only the phase-0 form (c2VydmljZV9yb2xl) misses real keys whose ref
# length lands the claim at a non-zero phase (this project's key is phase 1).
# All three invariant fragments are matched below. The anon/publishable key
# (role=anon) does NOT contain any of these fragments, so .env stays clean.
scan "Supabase JWT with service_role claim" 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]*(c2VydmljZV9yb2xl|cnZpY2Vfcm9s|ZXJ2aWNlX3Jv)[A-Za-z0-9_-]*\.'
# Supabase new-format secret keys.
scan "Supabase secret key (sb_secret_)" 'sb_secret_[A-Za-z0-9_-]{10,}'
# Common provider secrets.
scan "Stripe-style secret key" 'sk_(live|test)_[A-Za-z0-9]{10,}'
scan "AWS access key id" 'AKIA[0-9A-Z]{16}'
scan "Private key block" '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----'
scan "GitHub token" 'gh[posru]_[A-Za-z0-9]{20,}'
scan "Google API key" 'AIza[0-9A-Za-z_-]{30,}'
scan "Slack token" 'xox[baprs]-[A-Za-z0-9-]{10,}'
scan "OpenAI/project secret key" 'sk-(proj-)?[A-Za-z0-9_-]{20,}'
# Explicit assignment of a service role key to a variable in tracked config.
scan "SERVICE_ROLE key assignment with literal value" 'SERVICE_ROLE(_KEY)?\s*[:=]\s*["'"'"']?eyJ'

if [[ "$FAIL" -ne 0 ]]; then
  echo ""
  echo "Secret material must live in Supabase/Lovable secret storage, never in the repo."
  echo "Rotate any key that was committed — git history preserves it."
  exit 1
fi

echo "✅ Secret scan passed (tracked files contain no known secret patterns)."
