#!/usr/bin/env bash
# Merge the latest t3code (remote "upstream") into the current t4code branch, verify, push to origin.
# Usage: bash scripts/sync-upstream.sh
#   UPSTREAM_SOURCE=/e/workspace/t3code bash scripts/sync-upstream.sh   # fetch from a local clone
set -euo pipefail

branch="$(git branch --show-current)"
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，请先提交或 stash。" >&2
  exit 1
fi

source="${UPSTREAM_SOURCE:-upstream}"
git fetch "$source" main:refs/remotes/upstream/main

if ! git merge --no-edit upstream/main; then
  echo >&2
  echo "合并有冲突。文案冲突取上游版本，图标冲突取 t4code 版本（git checkout --ours assets apps/web/public），" >&2
  echo "然后执行：bash scripts/t4-rebrand.sh && git add -A && git commit --no-edit && git push origin $branch" >&2
  echo "冲突处理原则见 CLAUDE.md 的「上游同步」一节。" >&2
  exit 1
fi

bash scripts/t4-rebrand.sh
if [ -n "$(git status --porcelain)" ]; then
  git commit -qam "chore: re-apply t4code branding after upstream merge"
fi

pnpm install
pnpm typecheck
git push origin "$branch"
echo "已合并 upstream/main 并推送到 origin/$branch。"
