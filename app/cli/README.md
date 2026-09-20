# Local CLI — first release

Requires Node 22.12+ and the built app. From `app/` run `npm ci`, `npm run build`, then `node cli/corral.mjs --help`. The executable `cli/corral.mjs` is also the package `bin` entry; it loads `out/runtime/cli.mjs`. Distribute the CLI and built outputs together with Electron and the application dependencies. No global install is required. `npm run dev` starts the desktop directly; `npm run build:runtime` rebuilds only the Node CLI.

Exactly five canonical commands ship:

```
node cli/corral.mjs agent-context --json
node cli/corral.mjs serve --json
node cli/corral.mjs status --json
node cli/corral.mjs open --json
node cli/corral.mjs diagnostics memory --json
```

`--help` and `agent-context` never connect or start the app. All commands support `--json`. Successful calls exit 0; errors exit 1, including a stopped runtime. JSON mode emits one JSON document on stdout (serve emits its ready document and remains in the foreground); plain errors go to stderr. These commands do not consume stdin. Unknown commands/options, positionals and duplicate options fail before effects. No legacy command entry or alternate environment-variable dispatch exists.

The release supports local Unix sockets on macOS/Linux only. Remote hosts, environments, pairing, TCP ports, project roots, mobile and recipe options are rejected. Worktree, terminal, agent, browser and service CLI commands are not registered. Existing GUI actions remain available through the palette.

## Profiles and targets

`CORRAL_USER_DATA` selects an isolated profile; default is the desktop userData directory. `CORRAL_RUNTIME_SOCKET` or `--socket /absolute/private/path/rpc.sock` selects its socket. An explicit socket overrides the environment. Socket and parent must belong to the current user and have private permissions (socket 0600, parent 0700). Paths must fit 100 UTF-8 bytes. `CORRAL_CLI_SOCKET` is not a legacy fallback.

`status`, `open` and `diagnostics memory` accept `--instance <runtimeId>` from status. This identifies the persistent profile; status also returns a per-process `instanceId` and PID which change on restart. Wrong identities fail before effects; `open --instance` does not create a missing runtime. `--timeout-ms 1..120000` bounds client waiting (default 10 seconds; open 20 seconds). SIGINT/SIGTERM cancel waiting; a lost response returns `outcome_unknown`. Cancellation or timeout cannot undo an already accepted desktop launch. The client never automatically retries a mutation.

`serve` owns the foreground local RPC runtime and exits cleanly on SIGINT/SIGTERM. `open` focuses an existing desktop, starts one when stopped, or asks serve to release ownership and starts the desktop on the same profile. `runtime.state=ready` means the RPC runtime is ready; `ui.available` distinguishes a desktop window. It does not imply a backend is connected. Desktop backend connection remains visible through the GUI's existing link state.

## Backend and measurement scope

This slice does not install, patch, start or stop herdr. Existing desktop session discovery remains supported. To preserve a specific externally started backend through headless-to-desktop handoff, set **both** `CORRAL_BACKEND_SOCKET` and `CORRAL_SESSION` when starting serve. Their binding is saved in the profile and restored by desktop; conflicting later values fail. The backend process and its PTYs remain independently owned. A new profile is needed to bind a different backend; there is no implicit migration or session deletion.

`diagnostics memory` runs `ps` in the selected runtime and reports RSS bytes, CPU percent, main/renderer/other process totals and collection time. Scope covers the runtime, descendants and Electron's process-role PIDs. Independent backend and terminal processes are explicitly excluded; no worktree attribution is claimed. Host memory uses OS free memory (not reclaimable-memory estimation). Missing runtime, failed `ps`, or a missing runtime PID returns an error rather than zero. CPU is the `ps` sample, not a new interval measurement.

## Reproduce isolated verification

Run with Node 22 on PATH:

```
node scripts/l391-first/cli-verify.mjs
node scripts/l391-first/gui-verify.mjs
TMPDIR=/tmp npx vitest run
```

GUI verification uses the installed herdr 0.9.0, an isolated XDG configuration and named backend, private profile/repository/sockets, actual Electron input, screenshots and trusted Chromium IME events. It never starts a Claude session. Test artifacts are under `specs/LIFE-391-command-palette-cli/raw/first-release/codex/`; temporary fixture directories remain for inspection, processes are stopped.
