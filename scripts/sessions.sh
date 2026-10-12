#!/usr/bin/env bash
#
# sessions.sh — sign people out of the app by revoking their session tokens.
# App sessions are HS256 JWTs that last 180 days (backend/src/lib/jwt.ts), so
# these are the way to end one early. Needs AWS CLI credentials for the account.
#
# Usage:
#   scripts/sessions.sh revoke-user <stage> <email>   # sign one user out everywhere
#   scripts/sessions.sh revoke-all  <stage>           # sign every user out (you too)
#
# Examples:
#   scripts/sessions.sh revoke-user prod friend@gmail.com
#   scripts/sessions.sh revoke-all staging
#
# revoke-user adds 1 to tokenVersion on that user's USER#<id>/PROFILE item.
# Every API call compares the token's `ver` claim with it (lib/http.ts), so the
# user's tokens stop working on their next request. It does not stop them
# signing in again with Google: existing accounts skip the sign-up allowlist.
#
# revoke-all generates a new jwt-secret in the Keychain and pushes it with
# scripts/secrets.sh (gen + push). push sends all five parameters, so all five
# must be in the Keychain (macOS only). Each warm Lambda container keeps its
# cached copy of a parameter for up to 5 minutes (CACHE_TTL_MS in
# backend/src/lib/config.ts). For up to 5 minutes after the push, a warm
# container can still accept old tokens, and a sign-in it handles gets a token
# signed with the old secret, which then fails and needs a second sign-in.
# New containers read the new secret at once.
#
set -euo pipefail

REGION="eu-west-2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

check_stage() {
  [[ "$1" == "staging" || "$1" == "prod" ]] || die "stage must be staging or prod, not '$1'"
}

cmd_revoke_user() {
  local stage="${1:?usage: revoke-user <stage> <email>}" email="${2:?usage: revoke-user <stage> <email>}"
  check_stage "$stage"
  [[ "$email" =~ ^[^[:space:],\"@]+@[^[:space:],\"@]+$ ]] || die "not an email address: '$email'"
  local table="s2c-main-$stage" lower pks count pk version
  lower="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"

  # There is no index on email, so find the PROFILE item with a filtered scan
  # (read-only; the table holds a handful of users). Google normally reports
  # emails in lower case; the scan matches the email as typed or lower-cased.
  pks="$(aws dynamodb scan --region "$REGION" --table-name "$table" \
    --filter-expression 'SK = :profile AND email IN (:email, :lower)' \
    --expression-attribute-values \
      "{\":profile\":{\"S\":\"PROFILE\"},\":email\":{\"S\":\"$email\"},\":lower\":{\"S\":\"$lower\"}}" \
    --projection-expression PK --query 'Items[].PK.S' --output text)"
  count="$(printf '%s' "$pks" | wc -w | tr -d ' ')"
  [[ "$count" == "1" ]] || die "expected one account for $email in $table, found $count"
  pk="$(printf '%s' "$pks" | tr -d '[:space:]')"

  version="$(aws dynamodb update-item --region "$REGION" --table-name "$table" \
    --key "{\"PK\":{\"S\":\"$pk\"},\"SK\":{\"S\":\"PROFILE\"}}" \
    --update-expression 'ADD tokenVersion :one' \
    --condition-expression 'attribute_exists(PK)' \
    --expression-attribute-values '{":one":{"N":"1"}}' \
    --return-values UPDATED_NEW --query 'Attributes.tokenVersion.N' --output text)"
  echo "revoked every session for $email in $stage (tokenVersion is now $version)" >&2
  echo "they can still sign in again with Google; existing accounts skip the allowlist" >&2
}

cmd_revoke_all() {
  local stage="${1:?usage: revoke-all <stage>}" confirm
  check_stage "$stage"
  echo "This rotates /s2c/$stage/jwt-secret and signs out every $stage user, you included." >&2
  read -rp "Type the stage name to confirm: " confirm
  [[ "$confirm" == "$stage" ]] || die "not confirmed, nothing changed"

  "$SCRIPT_DIR/secrets.sh" gen "$stage" jwt-secret
  "$SCRIPT_DIR/secrets.sh" push "$stage"
  echo "done: new jwt-secret pushed for $stage" >&2
  echo "warm Lambda containers switch within 5 minutes; until then a sign-in may need repeating" >&2
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    revoke-user) cmd_revoke_user "$@" ;;
    revoke-all)  cmd_revoke_all  "$@" ;;
    *) die "usage: sessions.sh {revoke-user <stage> <email> | revoke-all <stage>}" ;;
  esac
}

main "$@"
