@AGENTS.md

# t4code

t4code is a personal fork of [t3code](https://github.com/pingdotgg/t3code) (MIT). It keeps the t3code
architecture (Node server + web/desktop/mobile/marketing clients) and adds features on top. Only the
desktop app is built and used for now.

## 上游同步（Upstream sync）

Git remotes:

- `upstream` → `https://github.com/pingdotgg/t3code.git` (t3code, read-only for us)
- `origin` → `https://github.com/sijingl2019/t4code.git` (this repo)

History: `master` sits directly on top of t3code's `main` history (the first t4code commit's parent is
a real t3code commit), so upstream updates arrive by an ordinary `git merge`, never by copying files.

To pull a new t3code release and keep our changes:

```bash
bash scripts/sync-upstream.sh
# or, from a local clone that is already up to date:
UPSTREAM_SOURCE=/e/workspace/t3code bash scripts/sync-upstream.sh
```

The script refuses a dirty tree, fetches `upstream/main`, merges it, runs `pnpm install` and
`pnpm typecheck`, and pushes to `origin`. On conflicts it stops; resolve, commit, push.

Rules that keep merges cheap (follow them for every t4code change):

1. **Prefer new files** for t4code features (e.g. `apps/server/src/issues/`,
   `packages/contracts/src/issues.ts`). Upstream never touches them, so they never conflict.
2. **Edits to upstream files stay small and additive**: add a field, a list entry, or a handler line
   next to the existing ones. Do not reformat, rename, or move upstream code.
3. **Do not rename `@t3tools/*` packages** or other upstream identifiers; only app identity strings
   were changed (see below).
4. When resolving a conflict, take upstream's version and re-apply the t4code addition on top.
   After the merge, check the "Upstream files t4code touches" list below still holds.

Install note: npmmirror lags npm for some pre-release versions t3code pins, which fails pnpm's
`minimumReleaseAge` check ("version not present in registry manifest"). Route just those scopes to
npm in `~/.npmrc`, e.g. `@distilled.cloud:registry=https://registry.npmjs.org/`.
Node 26 is required (nvm-windows: `D:\Softwares\Nvm\v26.7.0`).

## Upstream files t4code touches

Isolation from an installed t3code (data dir `~/.t4`, scheme `t4code://`, app id `com.t4code.app`,
product name "T4 Code"):
`apps/desktop/package.json`, `apps/desktop/scripts/electron-launcher.mjs`,
`apps/desktop/src/app/{DesktopEnvironment,DesktopStatePaths,DesktopUserData}.ts`,
`apps/desktop/src/electron/ElectronProtocol.ts`, `apps/server/src/{os-jank,httpCors}.ts`,
`packages/shared/src/{codexAuthHandoff,providerAuthReturnUrl}.ts`, `scripts/build-desktop-artifact.ts`
(also: staged package name `t4code` so the default install dir is `%LOCALAPPDATA%\Programs\t4code`, not T3's;
mac/linux protocol schemes `t4code`; NSIS assisted installer with a choosable install directory;
`WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT` raised from 80 to 100, the current payload is 89 files).

Branding (T4 Code name, `~/.t4` home including dev default and remote SSH/WSL runtimes): applied by
`scripts/t4-rebrand.sh`, a sed pass over upstream text that `sync-upstream.sh` re-runs after every
merge. On a text conflict take upstream's side and re-run the script; never hand-edit "T3 Code" lines.
The MCP server now advertises "T4 Code", so `packages/shared/src/t3McpToolPresentation.ts` matches
`t[34]` in its display-name prefix regex.
Code identifiers (`@t3tools/*`, `T3CODE_*`, `t3.json`, the worktree-local `.t3` dev dir), docs and
the marketing site stay upstream's. Icons (`assets/{prod,dev}`, `apps/web/public`) were retouched
from T3 to T4 by hand; on an icon conflict keep ours (`git checkout --ours`).

Features:

- Window background image + opacity: client settings `windowBackgroundImage` /
  `windowBackgroundOpacity` (`packages/contracts/src/settings.ts`), overlay in
  `apps/web/src/appInit.tsx`, UI in `AppearanceSettingsPanel.tsx`, reset/search entries in
  `SettingsPanels.tsx` / `settingsSearch.ts`.
- Sidebar grouped by project with an always-visible new-thread button on the project row:
  `boringSidebarEnabled` defaults to `true` (`settings.ts`), `SidebarProjectFolderHeader.tsx`.
- ONES issues (server settings `ones`, `issueRepoCredentials`, `issueProjectBindings`,
  `issueAutoDev`): service in `apps/server/src/issues/`, RPCs `issues.*` in
  `packages/contracts/src/{issues,rpc}.ts`, scopes in `apps/server/src/auth/RpcAuthorization.ts`,
  handlers + shared `projectCloneHooks` in `apps/server/src/ws.ts`, layer in
  `apps/server/src/orchestration-v2/runtimeLayer.ts`, secrets in `apps/server/src/settingsSecrets.ts`, span aggregates in `apps/server/src/observability/RpcInstrumentation.ts`, mock layer in `apps/server/src/ws.test.ts`.
  Client: commands in `packages/client-runtime/src/state/server.ts`, guarded scopes in
  `packages/contracts/src/clientRpcPermissions.ts`, settings form `OnesIssueSettings.tsx` (mounted in
  `SourceControlSettings.tsx`), issue picker `components/sidebar/OnesIssuePickerDialog.tsx` (opened from
  `SidebarProjectFolderHeader.tsx`), attachments handed to the composer via
  `apps/web/src/issues/pendingIssueFiles.ts` (consumed in `ChatComposer.tsx`).
- Terminal font picker: already upstream (`TypographySettings.tsx`, `FontFamilyPicker.tsx`).

## ONES API

Endpoints are the ones verified against the real private deployment in `e:/workspace/kika`
(`docs/ones-api-notes.md` there). `apps/server/src/issues/OnesClient.ts` is a direct port; do not switch
to unverified endpoints (e.g. `project_in` filters) without probing the server first.

## Packaging (Windows)

`pnpm dist:desktop:win:x64` writes `release/T4-Code-<version>-x64.exe`. On this machine it needs the
MSVC Spectre libraries (VS Build Tools component `VC.Runtimes.x86.x64.Spectre`), the npmmirror binary
mirrors (`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`,
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`), and `TEMP`/`TMP`/`TMPDIR` pointed at a
directory with no `node_modules` above it (e.g. `E:\tmp\t4build`), because `C:\Users\linsj\node_modules`
makes the sidecar self-containment check refuse. Local builds have no update feed.
