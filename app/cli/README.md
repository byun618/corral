# Local CLI

Requires Node 22.12+ and the built app. From `app/` run `npm ci`, `npm run build`, then `node cli/corral.mjs --help`. The executable `cli/corral.mjs` is also the package `bin` entry; it loads `out/runtime/cli.mjs`. Distribute the CLI and built outputs together with Electron and the application dependencies. No global install is required. `npm run dev` starts the desktop directly; `npm run build:runtime` rebuilds only the Node CLI.

The five foundation commands are:

```
node cli/corral.mjs agent-context --json
node cli/corral.mjs serve --json
node cli/corral.mjs status --json
node cli/corral.mjs open --json
node cli/corral.mjs diagnostics memory --json
```

`--help` and `agent-context` never connect or start the app. All commands support `--json`. Successful calls exit 0; errors exit 1, including a stopped runtime. JSON mode emits one JSON document on stdout (serve emits its ready document and remains in the foreground); plain errors go to stderr. These commands do not consume stdin. Unknown commands/options, positionals and duplicate options fail before effects. No legacy command entry or alternate environment-variable dispatch exists.

The release supports local Unix sockets on macOS/Linux only. It also ships 19 local repo/project/worktree commands, 10 terminal commands and 10 orchestration commands; see `agent-context` and command `--help` for the complete options. Remote hosts, environments and pairing require LIFE-403; setup/archive hooks require LIFE-412. Browser and service command groups are not registered. Existing GUI actions remain available through the palette.

## Terminals and agents

`terminal create/list/show/read/send/wait/switch/rename/close` need a connected corral terminal backend (`app/backend/README.md`); an unpatched herdr is refused with `unsupported_backend` rather than driven without its guard.

`terminal create --agent claude|codex|grok` starts a managed provider in the new PTY and `terminal prompt` submits one body to it. `--model/--effort/--advisor/--prompt/--prompt-file` require `--agent`, `--command` and `--agent` are mutually exclusive, and `--advisor` applies to `--agent claude` only; each rejection is an effect-free `invalid_request`. `worktree create --agent` synthesizes the same `terminal create --agent` after git succeeds and reports the worktree, terminal, agent and prompt stages one by one — a created worktree is never removed because a later stage failed, and a stage whose effect was not observed stays `unknown` and is not retried.

An agent is `ready` only when two observations 750 ms apart are all quiet — `idle` or `done`, interactive and not launch-pending — with one unchanged `state_change_seq`, **and** the guard reports the expected bundled detect manifest. `done` is an `idle` whose completion was not seen: on a completion transition herdr sets `seen` to `is_active_tab && outer_terminal_focus != Some(false)`, so a pane that is not the active tab, or whose window focus is explicitly false, reports `done` at the end of every turn it finishes — a headless pane that *is* the active tab still reports `idle`. That is GUI attention, not readiness, so both states take the next prompt. `wait --for agent-ready` and `--for agent-idle` run that one predicate and differ only in when they are asked and about what, and both return `satisfied: false` immediately on a blocking screen or an unverified detect manifest instead of waiting out the deadline — waiting cannot make either pass. `phase` is never reported as `ready` while that gate does not hold right now, whatever the reason: an unverified manifest, a working frame, a `state_change_seq` that moved, or a deadline that left room for one sample. Such a pane reports `launching`, and `agent.evidence` (`samples`, `detectManifest`) says which of those it was. A trust or login screen is the human's to clear; corral never answers one.

Submission is fail-closed and effect-free when refused: `detect_manifest_unverified`, `agent_blocked`, `agent_not_ready`, `prompt_already_delivered`. A prompt without `--wait` is `queued`, never `completed`: herdr acknowledged the queue and corral has not yet seen the body in the provider's own session record. Bodies are compared by length and digest after trimming only SPACE, TAB, CR and LF — NBSP and BOM are content.

Delivery and the wait are two answers, reported separately. `record.matchCount`/`record.unavailableReason` answer delivery: exactly one match inside the submission window — at or after the submit second, past the pre-submit cursor, and with that cursor's prefix digest unchanged — is a confirmed delivery, and it is reported whatever happens afterwards. `wait.requested`/`wait.satisfied`/`wait.reason` answer the wait: `--wait accepted` is satisfied by that confirmation; `--wait responded` additionally needs a working turn observed *within this submission* and an assistant record after the match, closed by the same two-observation idle gate. A deadline, a blocking screen or an exit ends the wait with `satisfied: false` and `reason` `deadline`, `agent_blocked` or `agent_exited`. `outcome` is `completed` only for a satisfied wait; anything else is `outcome_unknown` and is never re-submitted automatically.

corral reads only the session record it can prove the pane owns: the session id it minted for claude and grok, and for codex the single rollout whose `session_meta` cwd is this directory and whose timestamp is at or after the launch. With no such rollout, or with more than one, the match count, the resolved model and the reported record path are all unknown rather than taken from another session's file. For claude the derived record path has one documented limit corral does not work around: a working directory whose `[^A-Za-z0-9] → -` conversion exceeds 200 characters is stored under a truncated name plus an undocumented hash of the full path, and `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the derived name outright. In both cases corral looks where the rule says and reports `not_found` rather than guessing.

Per-stage status is authoritative for a composition. `worktree create --agent` and `create --prompt` report `stages.*.status` one by one, and the synthesized top-level `outcome` is the coarser of the two: an effect-free agent rejection — a refused submission, an unverified manifest — leaves its stage `failed` or `not_started` while `outcome` may still read `unknown` because another stage's effect was not observed. Read the stage, not the summary, before deciding what to retry.

## Orchestration: Runs, Tasks and Dispatches

`orchestration run-create/run-use/run-current/run-list/run-show`, `task-create/task-list/task-update`, `dispatch` and `dispatch-show` keep the local record of what an AI coordinator is doing: which Task a given attempt belongs to, which pane and which agent generation that attempt was bound to, and what is still true after the runtime has been restarted. They start nothing. Launching a worker into a dispatched pane, its messages, its `worker_done` and its capability withdrawal are LIFE-410; this slice sends nothing to any pane and answers no dialog.

A **Run** (`run_<12 hex>`) groups Tasks. A **Task** (`task_<12 hex>`) carries a spec, optional dependencies and a status. A **Dispatch** (`ctx_<12 hex>`) is one *attempt* at a Task, bound to one terminal handle. The id prefixes match the ones the harness documents already use.

The current Run is bound **per profile**, not per calling terminal: a coordinator session works on one Run at a time, and this slice has no channel that carries the caller's terminal identity. `--run <id>` overrides the binding for a single call without rebinding it, so several Runs can be worked with anyway. With neither a binding nor `--run`, a command that needs a Run fails `run_required` before any effect and names `run-create`/`run-use` in `resources.recovery`.

### Statuses and transitions

Task status is `pending|ready|dispatched|completed|failed|blocked`; Dispatch status is `dispatched|completed|failed|unknown`. A Task with no dependencies, or whose dependencies have all completed, is created `ready`; otherwise it is `pending` and is promoted to `ready` inside the same atomic write that completes its last dependency.

`task-update` is the only manual transition, and its table is exactly: `dispatched → completed|failed`, anything except `completed` `→ blocked`, and `blocked → ready|pending`. `ready → dispatched` belongs to `dispatch` alone, `completed` is terminal, and everything else is `illegal_transition` with the allowed set in `resources`. `blocked → ready` additionally requires every dependency completed, which keeps `ready` meaning what it says; `blocked → pending` is always available.

Checks run in a fixed order and every rejection is effect-free: `--expected-version` mismatch is `version_conflict`, then an illegal move is `illegal_transition`, then a `--dispatch` that is not the open attempt is `stale_dispatch`. So settling an already-settled Task is `illegal_transition` even when the caller names the attempt that settled it, while naming a superseded attempt of a still-open Task is `stale_dispatch`. Omitting `--dispatch` settles whichever attempt is open.

`dispatch --task --to <handle>` resolves the handle through the terminal module's own three-layer check — an unverifiable handle is `invalid_terminal`, one from another runtime or backend generation or whose PTY is gone or replaced is `stale_terminal`, and a profile with no reachable backend is `backend_unavailable`. The attempt stores the target identity (`handle`, `runtimeId`, `epoch`, `ptyId`, `paneId`) and a snapshot of the pane's managed agent — kind, name, phase, requested and resolved model/effort/advisor, argv and session id — or `null` with an `agentAbsenceReason` when the pane has none. A Task is startable when it is `ready`, or when its most recent attempt ended `failed` or `unknown`; that retry becomes attempt *n+1* and the superseded attempt is left untouched. Everything else is `task_not_startable` with `reason` and `unmetDependencies`.

`failed` means an **observed** failure and nothing else. An absent pane, a replaced PTY, a moved backend generation and an unreachable backend are never turned into `failed`, and nothing is ever retried automatically.

### Resume

Before every orchestration command, and again inside `dispatch-show`, every open attempt is re-observed. That is a superset of the three moments resume has to cover — runtime start, backend reconnect, and `dispatch-show` — because the first command after any of them passes through it. With no open attempt the backend is not contacted at all.

The same generation alive keeps the attempt `dispatched` and reports `terminal.live: true`. An absent pane, a replaced PTY or a changed backend generation settles the attempt `unknown` with `reason` `pane_gone`/`pty_replaced`/`epoch_changed` and leaves the **Task** `dispatched`, so it can be dispatched again as the next attempt. An unreachable backend records nothing at all: `terminal.live` is `"unknown"`, `observed` is `false`, and the stored document is left byte-identical, because "could not look" must never read as "looked and saw". Only reconcile creates `unknown`, and a human settles the Task afterwards with `task-update` — no `--dispatch` needed, since the attempt is already closed.

`dispatch-show`'s `terminal` block is the observation *that call* made; the record's `reconcile` block is the last observation that changed something, with the runtime instance that recorded it. An observation that repeats what is already stored writes nothing, so repeating the call leaves the document byte-identical.

### Storage and durability

All of it is one JSON document at `<userData>/runtime/orchestration/state.json`, rewritten atomically. A mutation that touches a Task, its attempt and two promoted dependents is still one `rename(2)`, so multi-record atomicity is a property of the layout rather than of a protocol. **The durability promise is the profile's existing one: process-crash safe, not power-loss safe** — the write is `open(O_EXCL)` → write → `fsync` → `rename`, with no directory `fsync` and no `F_FULLFSYNC`. A damaged document is reported as `storage_corrupt` and is never rewritten, truncated or silently reinitialized; an absent one is simply a new profile.

Every mutation accepts `--request-id` and mints one when it is omitted, sharing the profile's existing 24-hour receipt store: a replayed id returns the first result with `replayed: true`, the same id with different input is `request_conflict`, and a receipt still pending is `outcome_unknown` and is never re-executed. Mutations are serialized in one lane per runtime, reads included, because resume can write from a read path. Across processes the profile's single-owner runtime lock is what keeps one writer.

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

## Repository and worktree behavior

`project setup-clone --destination` takes a parent directory, which may already exist. The clone goes into a child named from the local path or HTTPS URL basename with `.git` removed. Only that final child is checked for collisions and reported in failure resources. SSH and credential-bearing URLs are unsupported. URL-derived names containing path separators, NUL, or `.`/`..` are rejected before cloning.

`worktree` JSON exposes branches as `refs/heads/<name>`. Selectors accept both `branch:<name>` and `branch:refs/heads/<name>`, as well as their bare forms. Display names and `preservedBranch.branchName` keep the short name.

Removal runs `git worktree remove` with at most one `--force`. A locked worktree therefore remains protected even with `--force`: Git rejects it and the path, branch and metadata remain. The CLI does not unlock it or silently pass a second force. For a branch created by this CLI, removal then attempts `git branch -d`; this uses that branch's upstream as the merge target, or the repository's current HEAD when no upstream exists. It does **not** enforce a fixed `main` merge target. A branch can consequently be deleted when its upstream contains the commit but main does not, or retained when HEAD contains the commit but its upstream does not. Failed `-d` and branches predating CLI creation are preserved and reported. No `-D` fallback is used.

Worktree creation may fail after Git has created a branch but before checkout, or after checkout during metadata/activation. Errors report the newly observed surviving branch/path in `resources`; the CLI does not automatically delete those resources. Inspect them before retrying. Existing branch/path collisions fail before creation and are not reported as newly created resources.

## Registry persistence and recovery

GUI and CLI read and update one `repos.json` containing repos, independent setups and path-keyed worktree metadata. Git remains the source of worktree existence. Existing v1 string arrays have stable canonical IDs and migrate on a successful write. The earlier candidate's `worktree-metadata.json`, if present and valid, is read only as migration input when the registry lacks metadata, then removed after the unified registry is committed. Stop older app versions before upgrading; simultaneous writers must use the same registry protocol. Ordinary 0755 userData is supported without chmod; runtime sockets still require their separate 0700 directory.

Each write re-reads the file under a lock and atomically renames the new JSON into place. The lock is a nonempty directory published by an atomic rename, containing a unique PID/UUID owner file. Competing writers wait at most 1.5 seconds and then fail with a retryable `Registry busy` message. No write is retried automatically. Only an owner proven dead by `kill(pid, 0)` returning ESRCH is reclaimed. A live owner, permission-denied liveness probe, or reused PID is never stolen; stop the relevant owner before retrying in those cases. Reclaim removes only the observed owner's unique file, so a late reclaimer cannot remove a new owner's nonempty lock directory.

A legacy empty lock file (which has no owner identity) or malformed lock is not safe to reclaim automatically. Stop every GUI/runtime process using that profile, inspect the exact `repos.json.lock` path reported by the error, remove that stale lock, then restart and retry. Abandoned uniquely named lock candidates/temp files after SIGKILL are harmless and may be removed while all profile owners are stopped. This protocol assumes a local filesystem and a shared PID namespace, not multi-host network storage. Parse/read errors fail explicitly and are never converted to empty successful state.

Unregistering a repo through setup-delete or the GUI removes its metadata and clears other worktrees' parent references to its IDs in the same transaction. It leaves Git and checkout files untouched. When legacy metadata needs ownership resolution, unregistering runs a Git query under the registry lock with a timeout of up to 5 seconds. A competing writer can therefore reach its existing 1.5-second wait limit and return `Registry busy`; retry after unregistering finishes.
