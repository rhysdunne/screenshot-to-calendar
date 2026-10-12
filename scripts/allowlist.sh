#!/usr/bin/env bash
#
# allowlist.sh — manage who may create an account. Sign-up is invite-only:
# POST /v1/auth/google creates a new user only when the Google account's
# verified email is on the list in /s2c/<stage>/signup-allowlist. Existing
# accounts always sign in, whatever the list says. A missing or empty list
# refuses every new sign-up.
#
# The parameter is a plain String, not a SecureString: it holds email
# addresses, not secrets. This script stores it lower-case and comma-separated.
# Each warm Lambda container caches it for up to 5 minutes
# (backend/src/lib/config.ts), so a change can take that long to apply.
#
# Usage:
#   scripts/allowlist.sh add    <stage> <email>   # let this Google account sign up
#   scripts/allowlist.sh remove <stage> <email>   # stop new sign-ups for it
#   scripts/allowlist.sh list   <stage>           # print the list, one per line
#
# Examples:
#   scripts/allowlist.sh add staging friend@gmail.com
#   scripts/allowlist.sh list prod
#
# Removing an email does not touch an account already created with it. To
# sign that person out, use scripts/sessions.sh revoke-user.
#
set -euo pipefail

REGION="eu-west-2"

die() { echo "error: $*" >&2; exit 1; }

check_stage() {
  [[ "$1" == "staging" || "$1" == "prod" ]] || die "stage must be staging or prod, not '$1'"
}

param() { echo "/s2c/$1/signup-allowlist"; }

normalise_email() {
  local email
  email="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$email" =~ ^[^[:space:],@]+@[^[:space:],@]+$ ]] || die "not an email address: '$1'"
  printf '%s' "$email"
}

# Print the stored list, one email per line. Prints nothing when the
# parameter does not exist yet. stderr goes to a temp file, not into the
# value, so a CLI warning can never be saved back as a list entry.
read_list() {
  local value errfile err
  errfile="$(mktemp)"
  if ! value="$(aws ssm get-parameter --region "$REGION" --name "$(param "$1")" \
    --query Parameter.Value --output text 2>"$errfile")"; then
    err="$(cat "$errfile")"; rm -f "$errfile"
    [[ "$err" == *ParameterNotFound* ]] && return 0
    die "could not read $(param "$1"): $err"
  fi
  rm -f "$errfile"
  printf '%s\n' "$value" | tr ',' '\n' | tr '[:upper:]' '[:lower:]' | tr -d ' \t' | grep -v '^$' || true
}

# Store a newline-separated list. Parameter Store refuses an empty value, so
# an empty list deletes the parameter, which closes sign-up.
write_list() {
  local stage="$1" joined
  joined="$(printf '%s\n' "$2" | grep -v '^$' | paste -sd, - || true)"
  if [[ -z "$joined" ]]; then
    aws ssm delete-parameter --region "$REGION" --name "$(param "$stage")"
    echo "the list is empty, so $(param "$stage") was deleted: new sign-ups are closed" >&2
    return
  fi
  aws ssm put-parameter --region "$REGION" --type String --overwrite \
    --name "$(param "$stage")" --value "$joined" >/dev/null
}

cmd_add() {
  local stage="${1:?usage: add <stage> <email>}" email current
  check_stage "$stage"
  email="$(normalise_email "${2:?usage: add <stage> <email>}")"
  current="$(read_list "$stage")"
  if printf '%s\n' "$current" | grep -qxF "$email"; then
    echo "$email is already on the $stage list" >&2
    return
  fi
  write_list "$stage" "$(printf '%s\n%s' "$current" "$email")"
  echo "added $email to $(param "$stage")" >&2
}

cmd_remove() {
  local stage="${1:?usage: remove <stage> <email>}" email current
  check_stage "$stage"
  email="$(normalise_email "${2:?usage: remove <stage> <email>}")"
  current="$(read_list "$stage")"
  printf '%s\n' "$current" | grep -qxF "$email" || die "$email is not on the $stage list"
  write_list "$stage" "$(printf '%s\n' "$current" | grep -vxF "$email" || true)"
  echo "removed $email from $(param "$stage")" >&2
}

cmd_list() {
  local stage="${1:?usage: list <stage>}" current
  check_stage "$stage"
  current="$(read_list "$stage")"
  if [[ -z "$current" ]]; then
    echo "(no list for $stage: new sign-ups are closed)" >&2
    return
  fi
  printf '%s\n' "$current"
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    add)    cmd_add    "$@" ;;
    remove) cmd_remove "$@" ;;
    list)   cmd_list   "$@" ;;
    *) die "usage: allowlist.sh {add|remove|list} <stage> [email]" ;;
  esac
}

main "$@"
