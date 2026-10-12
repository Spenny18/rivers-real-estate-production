#!/usr/bin/env bash
# Deploy to Fly — but only from a checkout that contains everything on
# GitHub's main.
#
# `flyctl deploy` ships whatever directory it runs in. Two checkouts deploy to
# the same app, and in October 2026 deploys from a checkout that was behind
# origin/main silently removed 17 merged features (showings, the Twilio
# business line, the inbox, app-owned contacts, e-sign envelopes) from
# production for a day. This refuses that.
#
#   npm run deploy                  # the normal way
#   npm run deploy -- --allow-dirty # also ship uncommitted changes (not on GitHub!)
set -euo pipefail

APP="luxury-homes-calgary"
allow_dirty=0
args=()
for a in "$@"; do
  if [ "$a" = "--allow-dirty" ]; then allow_dirty=1; else args+=("$a"); fi
done

git fetch origin --quiet

if ! git merge-base --is-ancestor origin/main HEAD; then
  behind=$(git rev-list --count HEAD..origin/main)
  echo "Refusing to deploy: this checkout is missing $behind commit(s) that are on origin/main."
  echo "Deploying it would remove those changes from production. Merge or rebase onto origin/main first:"
  git log --oneline HEAD..origin/main | head -20
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ] && [ "$allow_dirty" -ne 1 ]; then
  echo "Refusing to deploy: there are uncommitted changes, which would go live without being on GitHub."
  echo "Commit them (and open a PR), or re-run with --allow-dirty if you really mean to."
  git status --short --untracked-files=no | head -20
  exit 1
fi

echo "Deploying $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) to $APP"
exec flyctl deploy --app "$APP" "${args[@]+"${args[@]}"}"
