# Named entry points for local work. Run `just` to list them.
#
# Each recipe copies what CI does (.github/workflows/), so a green `just check`
# predicts green PR checks and `just deploy` matches the CI deploy. When a
# workflow changes, change the matching recipe in the same PR.

set shell := ["bash", "-euo", "pipefail", "-c"]

# AWS region for every stack (infra/bin/app.ts default)
region := "eu-west-2"

# List every recipe with its description
default:
    @just --list --unsorted

# npm ci in all four packages, backend first (the others import its source); mirrors ci.yml
install:
    cd backend && npm ci
    cd infra && npm ci
    cd evals && npm ci
    cd tools/prompt-improvement && npm ci

# Everything the ci.yml PR checks run: typecheck, lint, tests, mock eval (runs install first)
check: install
    cd backend && npm run typecheck && npm run lint && npm test
    cd infra && npm run typecheck && npm test
    cd evals && npm run typecheck && npm test && npm run eval -- --mock --label ci-smoke
    cd tools/prompt-improvement && npm run typecheck && npm test

# Compile the iOS app without signing, like ios.yml (set DEVELOPER_DIR to use another Xcode)
ios-build:
    cd ios && xcodegen generate
    cd ios && DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" \
        xcodebuild build -scheme Screenshot2Cal -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO

# Deploy web + backend to STAGE (staging|prod) from this machine: diff, confirm, deploy
deploy STAGE: (_stage STAGE)
    #!/usr/bin/env bash
    set -euo pipefail
    # An empty ALERT_EMAIL deploys fine but drops the alarm email subscription
    # (infra/lib/backend-stack.ts), so nobody hears the alarms. CI reads it
    # from the ALERT_EMAIL repo variable (deploy-stage.yml).
    if [ -z "${ALERT_EMAIL:-}" ]; then
      echo "ALERT_EMAIL is empty. Deploying now would remove the alarm email subscription." >&2
      echo "Fix: export ALERT_EMAIL=\$(gh variable get ALERT_EMAIL)" >&2
      exit 1
    fi
    # Same installs as deploy-stage.yml, so the bundle matches the lockfiles.
    npm ci --prefix backend
    npm ci --prefix infra
    cd infra
    npx cdk diff S2cWeb-{{ STAGE }} S2cBackend-{{ STAGE }}
    read -r -p "Deploy S2cWeb-{{ STAGE }} and S2cBackend-{{ STAGE }}? Type '{{ STAGE }}' to confirm: " answer
    if [ "$answer" != "{{ STAGE }}" ]; then
      echo "Not confirmed. Nothing deployed." >&2
      exit 1
    fi
    npx cdk deploy S2cWeb-{{ STAGE }} S2cBackend-{{ STAGE }}

# Follow a Lambda's logs, e.g. `just logs prod processor` (FN = CDK name, any case: authgoogle, capturescreate, ...)
logs STAGE FN SINCE="10m": (_stage STAGE)
    aws logs tail /aws/lambda/s2c-{{ lowercase(FN) }}-{{ STAGE }} --follow --since {{ SINCE }} --region {{ region }}

# Print how many failed captures sit on STAGE's dead-letter queue
dlq STAGE: (_stage STAGE)
    aws sqs get-queue-attributes --region {{ region }} \
        --queue-url "$(aws sqs get-queue-url --region {{ region }} --queue-name s2c-process-dlq-{{ STAGE }} --query QueueUrl --output text)" \
        --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
        --query Attributes --output table

# Live eval on the full dataset, production's models by default. COSTS MONEY: about $1.30 a run
eval MODELS="":
    #!/usr/bin/env bash
    set -euo pipefail
    # Cost: ~77 cases at the baseline's $/100 images (evals/reports/baseline):
    # Haiku 4.5 ~$0.30 + Sonnet 5 ~$1.00. To eval other models, pass a
    # comma-separated list: `just eval claude-haiku-4-5,claude-opus-4-8`.
    eval "$(scripts/secrets.sh env staging)"
    cd evals
    models="{{ MODELS }}"
    if [ -z "$models" ]; then
      # Production's classify + extract models, read from backend/src/lib/models.ts.
      models=$(npx tsx --eval "import { DEFAULT_MODELS as m } from '../backend/src/lib/models.ts'; console.log([...new Set([m.classify, m.extract])].join(','))")
    fi
    echo "Evaluating: $models"
    npm run eval -- --models "$models" --dataset all

# Tag and push the next ios-v<MARKETING_VERSION>-<N> build (Xcode Cloud -> TestFlight). Ship at least every 80 days
ship-ios REF="origin/main":
    #!/usr/bin/env bash
    set -euo pipefail
    # TestFlight builds expire after 90 days. Ship at least every 80 days so
    # testers never lose the app. Tag format and rules: .github/workflows/release.yml.
    git fetch --quiet --tags origin
    # Every target must carry the same x.y.z (two different values fail the match).
    version=$(sed -n 's/^ *MARKETING_VERSION: *"\(.*\)"/\1/p' ios/project.yml | sort -u)
    if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "ios/project.yml needs one x.y.z MARKETING_VERSION for every target. Found: $version" >&2
      exit 1
    fi
    last=$(git tag -l "ios-v${version}-*" | sed "s/^ios-v${version}-//" | { grep -E '^[0-9]+$' || true; } | sort -n | tail -1)
    tag="ios-v${version}-$(( ${last:-0} + 1 ))"
    sha=$(git rev-parse --verify "{{ REF }}^{commit}")
    if [ -n "$last" ]; then
      echo "Last build: ios-v${version}-${last}, tagged $(git for-each-ref --format='%(creatordate:short)' "refs/tags/ios-v${version}-${last}")"
    fi
    echo "Next build: $tag on {{ REF }} = $(git log -1 --format='%h %s' "$sha")"
    read -r -p "Type the tag name to tag and push it: " answer
    if [ "$answer" != "$tag" ]; then
      echo "Not confirmed. Nothing tagged." >&2
      exit 1
    fi
    git tag -a "$tag" -m "iOS build $tag" "$sha"
    git push origin "$tag"
    echo "Pushed $tag. release.yml creates the GitHub Release; Xcode Cloud starts the TestFlight archive."
    echo "Reminder: TestFlight builds expire after 90 days. Ship the next one within 80."

# Refuse any stage other than staging or prod
[private]
_stage STAGE:
    @if [ "{{ STAGE }}" != staging ] && [ "{{ STAGE }}" != prod ]; then echo "STAGE must be staging or prod (got: {{ STAGE }})" >&2; exit 1; fi
