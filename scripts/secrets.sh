#!/usr/bin/env bash
#
# secrets.sh — manage screenshot-to-calendar secrets via the macOS Keychain and
# push them into AWS Systems Manager Parameter Store (the app's source of truth).
# macOS only (uses the built-in `security` tool). Full guide: docs/secrets.md.
#
# Keychain service naming:  s2c-<stage>-<param>   e.g. s2c-staging-anthropic-api-key
#
# Usage:
#   scripts/secrets.sh set  <stage> <param>   # store a secret (hidden prompt)
#   scripts/secrets.sh gen  <stage> <param>   # generate + store a random 32-byte hex key
#   scripts/secrets.sh get  <stage> <param>   # print a secret to stdout
#   scripts/secrets.sh push <stage>           # push all 5 params -> Parameter Store
#   scripts/secrets.sh env  <stage>           # print `export ANTHROPIC_API_KEY=…`
#
# Examples:
#   scripts/secrets.sh set staging anthropic-api-key
#   scripts/secrets.sh gen staging jwt-secret        # for jwt-secret / token-enc-key
#   scripts/secrets.sh push staging                  # keychain -> Parameter Store
#   eval "$(scripts/secrets.sh env staging)"         # load key for a local eval run
#
# Note: the first `get`/`push` after storing may pop a keychain prompt — click
# "Always Allow" so future reads are non-interactive.
#
set -euo pipefail

REGION="eu-west-2"
# The five SecureStrings the backend reads (see docs/setup-aws.md §3).
PARAMS=(anthropic-api-key google-oauth-client-secret places-api-key jwt-secret token-enc-key)

die() { echo "error: $*" >&2; exit 1; }

require_macos() {
  [[ "$(uname)" == "Darwin" ]] || die "this helper uses the macOS 'security' tool; macOS only"
}

svc() { echo "s2c-$1-$2"; }  # stage, param -> keychain service name

cmd_set() {
  local stage="${1:?usage: set <stage> <param>}" param="${2:?usage: set <stage> <param>}"
  local value
  printf 'Value for %s (input hidden): ' "$(svc "$stage" "$param")" >&2
  read -rs value; echo >&2
  [[ -n "$value" ]] || die "empty value, nothing stored"
  security add-generic-password -U -a "$USER" -s "$(svc "$stage" "$param")" -w "$value"
  echo "stored $(svc "$stage" "$param") in the login keychain" >&2
}

cmd_gen() {
  local stage="${1:?usage: gen <stage> <param>}" param="${2:?usage: gen <stage> <param>}"
  local value
  value="$(openssl rand -hex 32)"
  security add-generic-password -U -a "$USER" -s "$(svc "$stage" "$param")" -w "$value"
  echo "generated + stored $(svc "$stage" "$param") (random 32-byte hex) in the login keychain" >&2
}

cmd_get() {
  local stage="${1:?usage: get <stage> <param>}" param="${2:?usage: get <stage> <param>}"
  security find-generic-password -a "$USER" -s "$(svc "$stage" "$param")" -w \
    || die "not found: $(svc "$stage" "$param") — store it with: secrets.sh set $stage $param"
}

cmd_push() {
  local stage="${1:?usage: push <stage>}"
  local param value
  for param in "${PARAMS[@]}"; do
    value="$(security find-generic-password -a "$USER" -s "$(svc "$stage" "$param")" -w 2>/dev/null)" \
      || die "missing $(svc "$stage" "$param") in keychain — store it first: secrets.sh set $stage $param"
    aws ssm put-parameter --region "$REGION" --type SecureString --overwrite \
      --name "/s2c/$stage/$param" --value "$value" >/dev/null
    echo "pushed /s2c/$stage/$param" >&2
  done
  echo "done: pushed ${#PARAMS[@]} parameters for stage '$stage'" >&2
}

cmd_env() {
  local stage="${1:?usage: env <stage>}"
  printf 'export ANTHROPIC_API_KEY=%q\n' "$(cmd_get "$stage" anthropic-api-key)"
}

main() {
  require_macos
  local sub="${1:-}"; shift || true
  case "$sub" in
    set)  cmd_set  "$@" ;;
    gen)  cmd_gen  "$@" ;;
    get)  cmd_get  "$@" ;;
    push) cmd_push "$@" ;;
    env)  cmd_env  "$@" ;;
    *) die "usage: secrets.sh {set|gen|get|push|env} <stage> [param]  (see docs/secrets.md)" ;;
  esac
}

main "$@"
