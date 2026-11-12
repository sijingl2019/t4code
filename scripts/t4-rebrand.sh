#!/usr/bin/env bash
# Re-applies t4code branding on top of upstream text. Idempotent: run it after every upstream merge
# (sync-upstream.sh does), and when resolving a conflict take upstream's side, then run this again.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

rewrite() { # rewrite <sed-expr> <git-grep-pattern> <pathspec...>
  local expr=$1 pattern=$2
  shift 2
  { git grep -lzE "$pattern" -- "$@" || true; } | xargs -0 -r sed -i -E "$expr"
}

# Product name in UI copy, messages, and agent instructions. Docs and the marketing site stay upstream's.
rewrite 's/T3( |%20|\+)Code/T4\1Code/g' 'T3( |%20|\+)Code' \
  apps/desktop apps/server apps/web apps/mobile packages scripts \
  ':!*.md' ':!**/_generated/**' ':!scripts/t4-rebrand.sh' \
  ':!apps/server/src/triage/triagePrompt*.ts' `# must stay byte-identical to .github/triage/PLAYBOOK.md` \
  ':!packages/shared/src/paletteSearch.test.ts' ':!packages/shared/src/speech.test.ts' # fixture text, not branding

# Home directory ~/.t3 -> ~/.t4 (local default, dev runner, remote SSH/WSL runtimes).
rewrite 's#\$HOME/\.t3\b#$HOME/.t4#g; s#~/\.t3\b#~/.t4#g; s#, "\.t3"([,)])#, ".t4"\1#g; s#/\.t3/worktrees/#/.t4/worktrees/#g' \
  '\$HOME/\.t3\b|~/\.t3\b|, "\.t3"[,)]|/\.t3/worktrees/' \
  apps/desktop/src/wsl/DesktopWslEnvironment.ts \
  apps/server/src/device/SshDeviceHost.ts \
  apps/server/src/cli/browser.ts \
  apps/server/src/project/AgentSessionScanner.ts \
  apps/server/src/project/AgentSessionScanner.test.ts \
  packages/ssh/src/tunnel.test.ts \
  scripts/dev-runner.test.ts \
  apps/server/scripts/migrate-dev-db.ts \
  apps/server/scripts/t3-sqlite-state.ts \
  packages/ssh/src/tunnel.ts \
  scripts/dev-runner.ts

# Installer file name.
rewrite 's/artifactName: "T3-Code-/artifactName: "T4-Code-/' 'artifactName: "T3-Code-' scripts/build-desktop-artifact.ts
