#!/usr/bin/env bash
# Hourly: fast-forward each project's repos (data/projects/*/repos/*) so bots work on current code, AGENTS.md
# and checks. A repo is touched only when it is clean, on origin's default branch and has no local commits;
# bots' wip branches and uncommitted work are left alone. pnpm install runs when the lockfile changed.
# Installed by deploy/setup-vps.sh as /etc/cron.hourly/pocketrocket-room-repo-sync (copied, not symlinked, so a
# bot can't rewrite root's cron job). The sync itself runs as the service user.
set -uo pipefail
APP_USER="pocketrocket"

if [ "$(id -u)" = 0 ] && [ -z "${ROOM_REPOS_ROOT:-}" ]; then
  sudo -u "$APP_USER" -H bash "$0" 2>&1 | logger -t pocketrocket-room-repo-sync
  exit 0
fi

ROOT="${ROOM_REPOS_ROOT:-/home/$APP_USER/pocketrocket/data/projects}"
DRY="${DRY_RUN:-0}"

for dir in "$ROOT"/*/repos/*/; do
  dir="${dir%/}"
  [ -d "$dir/.git" ] || continue
  g() { git -C "$dir" "$@"; }
  name="${dir#"$ROOT"/}"
  default="$(g symbolic-ref -q --short refs/remotes/origin/HEAD)" || { echo "skip $name: no origin/HEAD"; continue; }
  branch="$(g rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "${default#origin/}" ]; then echo "skip $name: on $branch, default is $default"; continue; fi
  if [ -n "$(g status --porcelain)" ]; then echo "skip $name: uncommitted changes"; continue; fi
  if ! g fetch -q origin; then echo "fail $name: fetch"; continue; fi
  behind="$(g rev-list --count "HEAD..$default")"
  ahead="$(g rev-list --count "$default..HEAD")"
  if [ "$ahead" != 0 ]; then echo "skip $name: $ahead local commits not on $default"; continue; fi
  if [ "$behind" = 0 ]; then echo "ok $name: current"; continue; fi
  if [ "$DRY" = 1 ]; then echo "would update $name: $behind behind $default"; continue; fi
  before="$(g rev-parse HEAD)"
  if ! g merge -q --ff-only "$default"; then echo "fail $name: ff-only merge"; continue; fi
  echo "updated $name: $behind commits, now $(g log -1 --format='%h %s')"
  if [ -d "$dir/node_modules" ] && [ -f "$dir/pnpm-lock.yaml" ] && ! g diff --quiet "$before" HEAD -- pnpm-lock.yaml; then
    if (cd "$dir" && pnpm install --frozen-lockfile --silent); then echo "deps $name: pnpm install ok"; else echo "fail $name: pnpm install"; fi
  fi
done
