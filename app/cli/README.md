# Local CLI

Requires Node 22.12+, clang (Xcode Command Line Tools — `npm run build` compiles the Resource Manager memory helper `helper/corral-footprint.c`, LIFE-676) and the built app. From `app/` run `npm ci`, `npm run build`, then `node cli/corral.mjs --help`. The executable `cli/corral.mjs` is also the package `bin` entry; it loads `out/runtime/cli.mjs`. Distribute the CLI and built outputs together with Electron and the application dependencies. No global install is required. `npm run dev` starts the desktop directly; `npm run build:runtime` rebuilds only the Node CLI. The installed app (`npm run package:mac`, see `../INSTALL.md`) bundles this CLI behind `corral.app/Contents/Resources/bin/corral`, which runs it on the app's own Node, adds `corral --version`, and makes `open` launch that bundle instead of the repo Electron.

The five foundation commands are:

```
node cli/corral.mjs agent-context --json
node cli/corral.mjs serve --json
node cli/corral.mjs status --json
node cli/corral.mjs open --json
node cli/corral.mjs diagnostics memory --json
```

`--help` and `agent-context` never connect or start the app. All commands support `--json`. Successful calls exit 0; errors exit 1, including a stopped runtime. JSON mode emits one JSON document on stdout (serve emits its ready document and remains in the foreground); plain errors go to stderr. These commands do not consume stdin. Unknown commands/options, positionals and duplicate options fail before effects. No legacy command entry or alternate environment-variable dispatch exists.

The release supports local Unix sockets on macOS/Linux only. It also ships 19 local repo/project/worktree commands, 10 terminal commands and 24 orchestration commands; see `agent-context` and command `--help` for the complete options. Remote hosts, environments and pairing require LIFE-403; setup/archive hooks require LIFE-412. Browser and service command groups are not registered. Existing GUI actions remain available through the palette.

## Terminals and agents

`terminal create/list/show/read/send/wait/switch/rename/close` need a connected corral terminal backend (`app/backend/README.md`); an unpatched herdr is refused with `unsupported_backend` rather than driven without its guard.

`terminal create --agent claude|codex|grok` starts a managed provider in the new PTY and `terminal prompt` submits one body to it. `--model/--effort/--advisor/--prompt/--prompt-file` require `--agent`, `--command` and `--agent` are mutually exclusive, and `--advisor` applies to `--agent claude` only; each rejection is an effect-free `invalid_request`. `worktree create --agent` synthesizes the same `terminal create --agent` after git succeeds and reports the worktree, terminal, agent and prompt stages one by one — a created worktree is never removed because a later stage failed, and a stage whose effect was not observed stays `unknown` and is not retried.

An agent is `ready` only when two observations 750 ms apart are all quiet — `idle` or `done`, interactive and not launch-pending — with one unchanged `state_change_seq`, **and** the guard reports the expected bundled detect manifest (for Claude, also the previous bundled version until the next bump: a new app must still reach a herdr server that has not restarted, which keeps the old detection). `done` is an `idle` whose completion was not seen: on a completion transition herdr sets `seen` to `is_active_tab && outer_terminal_focus != Some(false)`, so a pane that is not the active tab, or whose window focus is explicitly false, reports `done` at the end of every turn it finishes — a headless pane that *is* the active tab still reports `idle`. That is GUI attention, not readiness, so both states take the next prompt. `wait --for agent-ready` and `--for agent-idle` run that one predicate and differ only in when they are asked and about what, and both return `satisfied: false` immediately on a blocking screen or an unverified detect manifest instead of waiting out the deadline — waiting cannot make either pass. `phase` is never reported as `ready` while that gate does not hold right now, whatever the reason: an unverified manifest, a working frame, a `state_change_seq` that moved, or a deadline that left room for one sample. Such a pane reports `launching`, and `agent.evidence` (`samples`, `detectManifest`) says which of those it was. A trust or login screen is the human's to clear; corral never answers one.

Submission is fail-closed and effect-free when refused: `detect_manifest_unverified`, `agent_blocked`, `agent_not_ready`, `prompt_already_delivered`. Such a refusal reports `outcome: not_started`, and that is also what decides the receipt: a refusal that never began the effect leaves its `--request-id` **unspent**, so sending the same id again repeats the refusal rather than answering `outcome_unknown`, and a corrected body under that id is admitted. That holds **within the runtime that refused it**: after a restart the id is older than the receipt store and answers `outcome_unknown` like any other, and only a refusal that cannot prove the effect never ran keeps the id spent while the runtime lives. One more case keeps it spent: if the release itself could not be written the refusal is still reported as it stands, and the id answers `outcome_unknown` until its receipt expires — `orchestration request-show` is what tells the two apart, `released` against `pending`. A prompt without `--wait` is `queued`, never `completed`: herdr acknowledged the queue and corral has not yet seen the body in the provider's own session record. Bodies are compared by length and digest after trimming only SPACE, TAB, CR and LF — NBSP and BOM are content.

Delivery and the wait are two answers, reported separately. `record.matchCount`/`record.unavailableReason` answer delivery: exactly one match inside the submission window — at or after the submit second, past the pre-submit cursor, and with that cursor's prefix digest unchanged — is a confirmed delivery, and it is reported whatever happens afterwards. `wait.requested`/`wait.satisfied`/`wait.reason` answer the wait: `--wait accepted` is satisfied by that confirmation; `--wait responded` additionally needs a working turn observed *within this submission* and an assistant record after the match, closed by the same two-observation idle gate. A deadline, a blocking screen or an exit ends the wait with `satisfied: false` and `reason` `deadline`, `agent_blocked` or `agent_exited`. `outcome` is `completed` only for a satisfied wait; anything else is `outcome_unknown` and is never re-submitted automatically.

corral reads only the session record it can prove the pane owns: the session id it minted for claude and grok, and for codex the single rollout whose `session_meta` cwd is this directory and whose timestamp is at or after the launch. With no such rollout, or with more than one, the match count, the resolved model and the reported record path are all unknown rather than taken from another session's file. A claude session moved to the background (`←`, `/bg`) goes on in a new id's file and leaves `continued-in` at the end of the old one; corral follows that chain — the rule the chat view and phone input share (`main/transcript-continued.ts`), at most 8 hops — for the duplicate pre-check, the pre-submit cursor and the delivery count, reports the last file it reached as `record.path` and `agent.sessionRecord.path` (`agent.sessionRecord.continuedIn` lists the hops; `agent.sessionId` stays the minted id), and counts a row a later file copied from an earlier one (same `uuid`) once, so a body sent before the move is still refused once, not twice. When corral first looks and the minted file's ending is unreadable, its `continued-in` is outside the read window or the target file does not exist, it stays on the minted file, which is what it read before. Once a hop is proven, an unreadable tail keeps it, and a later hop that cannot be proven is not read. A minted session revived after its `continued-in` — new rows written to the old file — is read alone again, so a body that went only to the later file is not seen by the pre-check. With `--wait responded`, a move while the answer is being written can confirm the delivery and still leave the wait unsatisfied (`outcome_unknown`): the answer lands in a file whose copy of the body is folded away. For claude the derived record path has one documented limit corral does not work around: a working directory whose `[^A-Za-z0-9] → -` conversion exceeds 200 characters is stored under a truncated name plus an undocumented hash of the full path, and `CLAUDE_CODE_PROJECT_DIR_NAME` replaces the derived name outright. In both cases corral looks where the rule says and reports `not_found` rather than guessing.

Per-stage status is authoritative for a composition. `worktree create --agent` and `create --prompt` report `stages.*.status` one by one, and the synthesized top-level `outcome` is the coarser of the two: an effect-free agent rejection — a refused submission, an unverified manifest — leaves its stage `failed` or `not_started` while `outcome` may still read `unknown` because another stage's effect was not observed. Read the stage, not the summary, before deciding what to retry.

## Orchestration: Runs, Tasks and Dispatches

`orchestration run-create/run-use/run-current/run-list/run-show`, `task-create/task-list/task-update`, `dispatch` and `dispatch-show` keep the local record of what an AI coordinator is doing: which Task a given attempt belongs to, which pane and which agent generation that attempt was bound to, and what is still true after the runtime has been restarted. They start nothing. Launching a worker into a dispatched pane, its messages, its `worker_done` and its capability withdrawal are LIFE-410; this slice sends nothing to any pane and answers no dialog.

A **Run** (`run_<12 hex>`) groups Tasks. A **Task** (`task_<12 hex>`) carries a spec, optional dependencies and a status. A **Dispatch** (`ctx_<12 hex>`) is one *attempt* at a Task, bound to one terminal handle. The id prefixes match the ones the harness documents already use.

The current Run is bound **per profile**, not per calling terminal: a coordinator session works on one Run at a time, and this slice has no channel that carries the caller's terminal identity. `--run <id>` overrides the binding for a single call without rebinding it, so several Runs can be worked with anyway. With neither a binding nor `--run`, a command that needs a Run fails `run_required` before any effect and names `run-create`/`run-use` in `resources.recovery`.

### Statuses and transitions

Task status is `pending|ready|dispatched|completed|failed|blocked`; Dispatch status is `dispatched|completed|failed|unknown`. A Task with no dependencies, or whose dependencies have all completed, is created `ready`; otherwise it is `pending` and is promoted to `ready` inside the same atomic write that completes its last dependency.

`task-update` is the only manual transition, and its table is exactly: `dispatched → completed|failed`, anything except `completed` `→ blocked`, and `blocked → ready|pending`. `ready → dispatched` belongs to `dispatch` alone, `completed` is terminal, and everything else is `illegal_transition` with the allowed set in `resources`. `blocked → ready` additionally requires every dependency completed, which keeps `ready` meaning what it says; `blocked → pending` is always available — note that a Task whose dependencies are *already* met lands in `pending` with nothing left to wait for, since there is no manual `pending → ready`; `blocked` and back out is the way on.

**An open attempt also refuses `→ blocked`.** Settling a Task goes through `dispatched → completed|failed`, so moving it out of `dispatched` while its attempt is still open would leave that attempt with no manual end at all — a worker still using the pane could never be recorded as finished. That move is `illegal_transition` with `reason: dispatch_active` and the attempt's id, and it opens up as soon as the attempt ends: settle it, or let reconcile close it `unknown` once its pane is gone. corral never kills a live pane to unstick a record.

For a request that has passed flag validation the checks run in a fixed order, and every rejection is effect-free — the stored document is byte-identical afterwards: `--expected-version` mismatch is `version_conflict`, then an illegal move is `illegal_transition`, then a `--dispatch` that is not the open attempt is `stale_dispatch`. So settling an already-settled Task is `illegal_transition` even when the caller names the attempt that settled it, while naming a superseded attempt of a still-open Task is `stale_dispatch`. Omitting `--dispatch` settles whichever attempt is open. Validation runs before all of it, which is why `--status dispatched` is `illegal_transition` whatever the other flags say, and why `--result` outside `completed|failed` is `invalid_argument` rather than a value that is silently dropped.

`dispatch --task --to <handle>` resolves the handle through the terminal module's own three-layer check — an unverifiable handle is `invalid_terminal`, one from another runtime or backend generation or whose PTY is gone or replaced is `stale_terminal`, and a profile with no reachable backend is `backend_unavailable`. The attempt stores the target identity (`handle`, `runtimeId`, `epoch`, `ptyId`, `paneId`) and a snapshot of the pane's managed agent — kind, name, phase, requested and resolved model/effort/advisor, argv and session id — or `null` with an `agentAbsenceReason` when the pane has none. A Task is startable when it is `ready`, or when its most recent attempt ended `failed` or `unknown`; that retry becomes attempt *n+1* and the superseded attempt is left untouched. Everything else is `task_not_startable`, with `reason`, `unmetDependencies` and a `recovery` naming the next command: `dispatch_active` (an attempt is still open), `unmet_dependencies` (a `pending` Task, listing what it waits for), `not_ready` (a `pending` Task with nothing left to wait for), `task_blocked`, `task_completed`.

The stored `agent` block is an observation **made at dispatch time and never refreshed**. A pane dispatched while its provider was still starting keeps `phase: "launching"` and `resolvedModel: null` for the life of that record; ask `terminal show` for what the pane is doing now. That is the point of the record — it says which provider this attempt was handed to, not how that provider is faring.

The error codes this group can answer with, and what each one means: `run_required` (no Run bound and no `--run`), `run_not_found`, `task_not_found` (no such Task, or one in another Run — including a `--deps` entry), `dependency_cycle` (a Task naming itself), `illegal_transition`, `stale_dispatch`, `dispatch_not_found`, `version_conflict`, `task_not_startable`, `invalid_argument`, the terminal module's `invalid_terminal`/`stale_terminal`/`backend_unavailable` from the handle check, the receipt store's `request_conflict`/`outcome_unknown`/`receipt_capacity` (24 h capacity of 10 000 reached)/`request_expired` (a `--request-id` older than the 24 h retention), and `storage_corrupt`.

Every one of them is reported **before any write**, so the stored bytes are untouched and `outcome` is `not_started` — `outcome_unknown` is the single exception, and it means exactly that nobody knows. `stage` is narrower than that: the checks this module makes carry `stage: "preflight"`, while the codes raised by the borrowed receipt store and by the terminal module's handle check (`request_conflict`, `stale_terminal`, `invalid_terminal`, `request_expired`, `receipt_capacity`) carry no `stage` at all. Since a rejection now happens before the receipt exists, a refused mutation also leaves its `--request-id` **unspent**: fix the input, send the same id, and it is admitted then — and that holds for the ids the receipt store itself turns away before admission (a timestamp in the future, `request_expired`, `receipt_capacity`) as much as for this module's own checks. The `recovery` follows the outcome, not the code: a `not_started` rejection that carries no advice of its own says the input is what needs fixing, while `outcome_unknown` says the opposite — the mutation may already be stored, so read `run-show`/`task-list`/`dispatch-show` first and do not send the same input again under any id, which is how a duplicate record gets made.

`failed` means an **observed** failure and nothing else. An absent pane, a replaced PTY, a moved backend generation and an unreachable backend are never turned into `failed`, and nothing is ever retried automatically.

### Resume

Every open attempt is re-observed **once as the runtime becomes ready**, before every orchestration command, and again inside `dispatch-show` for an attempt that is still open. The runtime-start pass is a real one: a pane that died while corral was not running is `unknown` on disk without anyone having to issue a command first. There is no "backend reconnect" event to hook — this runtime holds no backend connection (`ownership: external`, `lifecycle: independent`, one connection per call) — so the first command after a reconnect is where that moment is observed. With no open attempt the backend is not contacted at all.

The observation has its own budget: **2000 ms, and never more than half of whatever time `--timeout-ms` has left; below 250 ms of share it is skipped entirely**. A backend that accepts the connection and then says nothing must not turn `run-list` into a ten-second `outcome_unknown`, and it must not turn `--timeout-ms 250` into one either: too little time to look is simply "could not look", which writes nothing and reports `observed: false` in `dispatch-show`'s `terminal` block — the only place this contract surfaces a field of that name; the same word covers both "the backend never answered" and "there was not enough of the deadline left to ask", and `detail` is what tells them apart. For the same reason the runtime-start pass **stops as soon as an orchestration command that is going to run arrives** — that command re-observes under its own deadline, so holding the lane against a backend that never answers would only cost the caller its timeout. A command rejected by validation never reaches the lane and never cuts the pass short. `dispatch --to` keeps the full timeout, because there the handle check *is* the command.

Where the result is written is part of the contract. A read command persists it — that re-observation is a record of what corral saw, and it stands whether the read itself then succeeds or fails. A **mutation** carries it into its own `atomicWrite` instead, so an accepted mutation is still one `rename(2)` and a rejected one — `task_not_startable`, `stale_dispatch`, `version_conflict`, `illegal_transition`, `run_required`, `invalid_terminal`, `stale_terminal`, a bad flag — leaves the stored bytes byte-identical and its `--request-id` unspent. "Rejected mutations write nothing" is the promise; a read that answers `dispatch_not_found` may still have recorded the reconcile it performed on the way.

The same generation alive keeps the attempt `dispatched` and reports `terminal.live: true`. An absent pane, a replaced PTY or a changed backend generation settles the attempt `unknown` with `reason` `pane_gone`/`pty_replaced`/`epoch_changed` and leaves the **Task** `dispatched`, so it can be dispatched again as the next attempt. An unreachable backend records nothing at all: `terminal.live` is `"unknown"`, `observed` is `false`, and the stored document is left byte-identical, because "could not look" must never read as "looked and saw". Only reconcile creates `unknown`, and a human settles the Task afterwards with `task-update` — no `--dispatch` needed, since the attempt is already closed.

For an attempt that was still open when the call started, `dispatch-show`'s `terminal` block is the observation *that call* made (`source: "observation"`) — including the observation that settled it `unknown`. For an attempt that was **already** settled — `completed`, `failed` or `unknown` — that call makes no observation of its own: the block repeats the stored reconcile with `live: null` and `source: "record"`, because whether that pane happens to be alive now says nothing about a finished attempt. (The command still runs the sweep that precedes every command, so if *another* attempt is open the backend is contacted once for that; with no open attempt it is not contacted at all.) The record's `reconcile` block is the last observation that changed something, with the runtime instance that recorded it. An observation that repeats what is already stored writes nothing, so repeating the call leaves the document byte-identical.

### Storage and durability

All of it is one JSON document at `<userData>/runtime/orchestration/state.json`, rewritten atomically. A mutation that touches a Task, its attempt and two promoted dependents is still one `rename(2)`, so multi-record atomicity is a property of the layout rather than of a protocol. **The durability promise is the profile's existing one: process-crash safe, not power-loss safe** — the write is `open(O_EXCL)` → write → `fsync` → `rename`, with no directory `fsync` and no `F_FULLFSYNC`. A damaged document is reported as `storage_corrupt` and is never rewritten, truncated or silently reinitialized; an absent one is simply a new profile.

Every mutation accepts `--request-id` and mints one when it is omitted, sharing the profile's existing receipt store with the terminal and workspace commands — one 24-hour, 10 000-entry window for all three, so heavy use of one module is what limits admission for the others. A replayed id returns the first result with `replayed: true`, the same id with different input is `request_conflict`, and a receipt still pending is `outcome_unknown` and is never re-executed — that answer is `stage: "receipt"`, `outcome: unknown`, and its `recovery` names the orchestration reads rather than a new id. Resolving the Run happens *before* the receipt is written, so a `run_required` rejection costs no id and the same `--request-id` can be used again once a Run exists; the error's own `recovery` survives — `run-create`/`run-use` for a missing Run, `terminal list` for a stale handle. Mutations are serialized in one lane per runtime, reads included, because resume can write from a read path. Across processes the profile's single-owner runtime lock is what keeps one writer.

## Orchestration: workers, messages and recovery

Fourteen commands are the other half of the same record: they put a provider session into a dispatched pane,
carry what it says back, and take the pane away again when it is done. A coordinator drives all of them except
`orchestration send` and `orchestration ask`, which are what the worker itself runs.

| Command | Who runs it | What it does |
| --- | --- | --- |
| `orchestration worker-start` | coordinator | create or re-use a pane, dispatch the Task into it, submit the preamble once |
| `orchestration worker-list` | coordinator | every attempt that was started as a worker, newest first |
| `orchestration worker-show` | coordinator | one attempt: its record, its ownership, its pane observed now, its last message |
| `orchestration worker-read` | coordinator | the pane's own output, by screen snapshot or by cursor |
| `orchestration send` | worker | a `worker_done`, `heartbeat`, `escalation` or `status` message |
| `orchestration ask` | worker | a question, and a wait for the answer (`--resume` keeps waiting) |
| `orchestration reply` | coordinator | answer one question, once |
| `orchestration check` | coordinator | take the next batch, `--block` to wait for one, `--ack` to release it |
| `orchestration inbox` | coordinator | read the mailbox without taking or acknowledging anything |
| `orchestration request-show` | either | what a `--request-id` receipt records: completed, pending, released or absent |
| `orchestration worker-retain` | coordinator | declare, before the release, that this pane is to be kept |
| `orchestration worker-release` | coordinator | close the pane of a settled attempt, if that attempt still owns it |
| `orchestration worker-stop` | coordinator | end an open attempt: close the pane, fail the Task `worker_stopped` |
| `orchestration worker-abandon` | coordinator | end an open attempt on paper only, leaving the pane exactly as it is |

`worker-start --task <task>` takes **exactly one** of `--terminal <handle>` (re-use a pane corral already started
an agent in) or `--agent claude|codex|grok --worktree <path>` (start one). It composes four things that already
existed: `terminal create --agent`, the Dispatch record, `terminal wait --for agent-ready`, and one
`terminal prompt`. The attempt is created **before** the body is built, because the preamble names it. Each stage
is reported on its own in `stages` and `effects`; a stage that fails leaves the earlier ones alone and names them
in `residualResources` rather than undoing them, so a pane is never closed to tidy up a record. A re-used pane
keeps the agent it was started with, which is why `--model`, `--effort`, `--advisor` and `--worktree` are refused
with `--terminal`, and a pane with no corral-managed agent is `agent_not_found` with no effect at all.

`launch` names which of three things happened — `created`, `reused` or `resumed` — and `ignoredOptions` lists the
options that could not take effect because the attempt already had both a pane and a body. A resume that was
reported as `created` told a reader a pane had just been made for them; listing what was dropped is the other half
of the same honesty.

One line is **typed** into the pane immediately before the preamble is pasted into it:
`The block pasted below is this session's task, delivered by corral. Follow it:`. It is there because a
provider that receives a message made entirely of pasted text refuses to act on it — claude 2.1.280 names it as
a possible injection, and it is right to: nothing in such a message was written by the person at the keyboard.
The line carries no newline, so the Enter that submits is still the prompt's own. **A Dispatch is one Enter and
one `promptRequestId`**, and that is what "once" counts.

That line is its own effect, and so is the paste. **Each is recorded before it is made** (`worker.lead`,
`worker.prompt`), and each record is a *claim*: it is written inside the document lane and only when the key is
still null, so the run that writes it is the only run that makes that effect. Two runs resuming the same
Dispatch at the same time both see `null` in the snapshots they planned from — the lane is the only place that
can decide between them — and the one that does not take the claim makes no call at all. **A Dispatch types at
most one lead and submits at most one body, in any race.** A claim is given back only when the child refused
*before any effect and said so*; a failure that carries no outcome, or one that says `unknown`, leaves the
record standing, because the text may well have reached the pane.

It matters more than it sounds: herdr appends to whatever is already on the input line, so a run that typed the
line and then failed leaves it there, and a resume that typed another would produce a message beginning with
the line twice. Such a message is no longer the body the Dispatch was created against — the duplicate pre-check
and the delivery judgement would both read one delivery as none, and the body would be submitted a second time
under a record showing one.

**What a resume believes, and what it will not do.** It believes two things: the Dispatch's own record, and the
receipt of the request id that record names. It does not read the pane's screen to decide anything — the screen
is the provider's drawing, a TUI puts the input line in a box with hint rows under it, and corral never parses
provider screens. So a resume that did not take a claim looks at the earlier run's receipt:

- **completed, and the answer in it is a delivery** — either the wait was satisfied, or the child's own record
  block says it proved this body present: `record.unavailableReason: null`, which `terminal prompt` writes only
  when it counted exactly one match, in a file it proved it owned, on a cursor it had not lost. That is a
  delivery this run *observed* rather than made, and the attempt goes on to `ready`.
- **pending or missing** — the effect may have happened and was never seen. The resume submits nothing and
  reports `state: incomplete` at stage `dispatch_input_unprovable`, naming the request id to look at, the pane
  to read, and `worker-stop` as the way out. Waiting is also an answer here: if another run is still mid-flight,
  it is that run's receipt this one is waiting to be able to read.
- **completed, and the answer in it is anything else** — `record.unavailableReason` carries a reason
  (`ambiguous`, `not_found`, `hook_blocked`), whatever the count beside it says. The resume does not go behind
  that verdict in either direction: it does not promote a match the child could not prove (a count of one on an
  invalidated cursor is unknown at the source), and it does not condemn a count of zero, because zero is also
  what a provider that had not written its record by the deadline answers. It submits nothing and stops at
  `dispatch_input_unprovable`, with the reason, the count and `cursorInvalidated` in `stages.input` so a person
  can read the verdict rather than take it on trust.
- **unreadable** — the receipt file exists and is not readable (`storage_corrupt`). corral neither repeats the
  effect nor rewrites the file: the same `dispatch_input_unprovable` answer carries `reason:
  receipt_unreadable` and the underlying code.

A resume does not count again — corral asks the pane nothing, and reading the provider's record is
`terminal prompt`'s own work, not the resume's. So an attempt that stops at `dispatch_input_unprovable` does not
converge on its own however many times it is resumed. The way out is a person: read the pane, and if the body is
in front of the provider the work is already running, so end the attempt with `worker-stop` rather than starting
over — a new Dispatch for the same Task on the same pane carries a different dispatch id, so the duplicate
pre-check does not recognise it, and the same body goes in a second time.

corral cannot clear a pane's input line (the terminal contract takes printable text only, so there is no Ctrl-U
to send). When an *earlier* run typed the lead, the answer carries an `input_line` entry in `residualResources`
naming the pane and the key a person presses — that comes from the record, not from a screen. The `lead:
{checked, present}` block in the answer is a diagnostic beside it and nothing branches on it: `present` is
`true` when the lead's text is somewhere on the screen and `null` otherwise. It is never `false`, because corral
cannot prove an input line is clear, and no value of it ever causes a line to be typed.

**The preamble reaches a pane exactly once per Dispatch.** The same `--request-id` replays the stored result and
submits nothing; a different id, while the attempt is open and its preamble delivered, is
`task_not_startable (dispatch_active)`. The one exception is an attempt whose input stage never completed — a
trust dialog, a deadline, a submission whose arrival was never seen: calling `worker-start` again for that Task
resumes the submission into the same pane and the same Dispatch, which is still exactly once, and `worker-show`
tells the two apart by whether `worker.promptRequestId` is set.

**A submission is judged, not assumed.** `state: ready` is reported only when `terminal prompt` answered
`outcome: completed` with its `wait` satisfied, or when this exact body was found in the provider's record
**exactly once** — a delivery observed rather than made. That finding reaches corral two ways: the duplicate
pre-check refusing a new submission (`prompt_already_delivered` with `matchCount: 1`), and the recorded receipt
of an earlier run's submission (`record.matchCount: 1`). The count is read through the receipt wrapper as well
as beside it: `terminal prompt` runs inside the receipt store, and a refusal that crosses it comes back with the
child's own resources under `detail` — reading it from one place only is how a delivery the provider had
accepted exactly once became a permanent "count unknown". `prompt_already_delivered` says "this body is in the
record", not "exactly once": two or more matches mean the one-input rule is already broken for that pane, and
reporting that as an accepted delivery would bury it under a `ready`. So anything else — `outcome: unknown`, an
unmet wait, queue acceptance, or a count of two or more — is `state: incomplete` at stage
`dispatch_input_unconfirmed`, with `stages.input.status: unknown`: the body may well have arrived,
`promptRequestId` stays null, and the attempt stays resumable. The resume then reads this run's receipt rather
than submitting a second time, and that pairing is what keeps "once" true across an answer corral could not
read. A Dispatch that never reached the pane is never reported as `ready`.

**A resume delivers the body the Dispatch was created against and nothing else.** The digest of that body is
recorded when the Dispatch is created, before anything is sent, and it is **the digest — not the flags on this
command line — that decides what a resume delivers**. Half a submission carrying text the other half never saw
would still read as one delivery in the record, which is exactly what the digest refuses.

That makes the two cases different without either of them trusting a flag:

- An attempt made from the **Task spec** resumes from the Task. A `--spec-file` left on the line appears in
  `ignoredOptions` and is **never opened** — so naming a path that has since gone away cannot refuse a resume the
  file has nothing to do with.
- An attempt made from a **`--spec-file`** is resumed by naming the same file again. Only when the Task no
  longer explains the stored digest is the file read, and then it is read to be *compared*: the same body
  resumes, a changed one is `preamble_mismatch` with no effect and a `recovery` naming both ways out.

A **new** attempt is a different question — there the file *is* the body, so an unreadable one is
`invalid_argument` before anything is created.

A worker pane inherits its environment from the backend, never from corral — corral cannot put environment
variables into a pane — so the preamble spells every command with this runtime's socket. This is the body it
delivers, verbatim:

```text
You are a corral worker. A coordinator session started this pane and supervises it through the
corral CLI. You talk to the coordinator only through the commands below — not through Slack,
not through GitHub, not through a local prompt.

Run: run_<12 hex>
Task: task_<12 hex>
Dispatch: ctx_<12 hex>
Terminal: t1.<handle>

=== CLI COMMANDS ===

```sh
  # Report the outcome (REQUIRED exactly once).
  #
  # RULE: --body is a 3-sentence executive summary (what you did, what you found, what is
  # left). Never send an empty body. If you produced a long artifact, pass --report-path so
  # the coordinator can find it without searching.
  #
  # RULE: send worker_done exactly once, with --outcome succeeded when the requested work is
  # done and --outcome failed when it is not. Never encode failure only in prose and never
  # exit silently. Both --task-id and --dispatch-id are required: a report that names a
  # superseded attempt is refused (stale_dispatch) and stores nothing.
  corral --socket <runtime socket> orchestration send \
    --type worker_done --subject "<short status>" \
    --body "<3-sentence summary: what you did, what you found, what is left>" \
    --task-id task_<12 hex> --dispatch-id ctx_<12 hex> --outcome succeeded \
    --files-modified "path/a,path/b" \
    --report-path "<optional: path to the full artifact>"

  # BEHAVIOR RULE: send a heartbeat every 5 minutes while actively working. The coordinator
  # uses it to tell "still thinking" from "hung". Skip heartbeats only while blocked inside
  # `ask` or `check --block` — those calls are themselves liveness signals.
  corral --socket <runtime socket> orchestration send \
    --type heartbeat --subject "alive" \
    --task-id task_<12 hex> --dispatch-id ctx_<12 hex> \
    --phase "<short: investigating|implementing|reviewing|waiting>"

  # Ask the coordinator a question and block until it answers.
  #
  # BEHAVIOR RULE (MUST NOT VIOLATE): NEVER use AskUserQuestion or any other local prompt.
  # It opens a dialog the coordinator cannot see and cannot answer, and your session hangs
  # forever. Every interactive question goes through `ask`.
  #
  # `ask` stores the question durably and then blocks. --timeout-ms is at most 600000. If it
  # times out you get state "pending" and a resumeCommand: run that instead of asking again,
  # or a duplicate question is created.
  corral --socket <runtime socket> orchestration ask \
    --question "<your question>" \
    --options "<optional,comma,separated>" \
    --task-id task_<12 hex> --dispatch-id ctx_<12 hex> --timeout-ms 600000

  # Escalate a blocker before completion, when the coordinator must act before you continue:
  corral --socket <runtime socket> orchestration send \
    --type escalation --subject "Blocked: <reason>" \
    --body "<details>" \
    --task-id task_<12 hex> --dispatch-id ctx_<12 hex>
```

=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this Task. Stop, return to an idle prompt and take no further
action: do not start unrelated work, do not poll in a loop, and do not exit the shell. Your
pane stays available. If the coordinator has more for you it delivers a fresh preamble and
TASK block into this same pane under a new Dispatch; treat that as new supervised work and
ignore the settled ids.

A direct instruction from the user takes precedence over this idle rule.
```

followed by a blank line, `=== TASK ===`, and the Task spec (or `--spec-file`). The TASK body is capped at 49152
bytes so the whole submission fits in one `terminal prompt`; `worker.preambleSha256` records what was delivered.

### Who may report

`send --type worker_done|heartbeat|escalation` and `ask` are worker calls: they name `--task-id` and
`--dispatch-id`, and the runtime accepts them **only from the pane that Dispatch was bound to**. `--type status`
is the one type either side sends — naming an attempt makes it that worker's status and it is verified exactly
like the others, naming none makes it a note on the Run; one of the two ids without the other is refused rather
than half-understood. The CLI reads
`HERDR_PANE_ID` and `HERDR_SESSION` from the shell herdr starts inside a pane and sends them beside the flags;
the runtime compares both with the Dispatch target, because pane ids repeat across backend sessions. Then it
**looks at the pane**. Comparing a claim against the stored ids compares a claim against a memory, and both still
agree after the pane they name has been closed and its id handed to a new PTY — which is exactly when a report is
most misleading. The epoch and the pty generation are what make the comparison about the pane that exists now:
the same three-layer check LIFE-393 makes before it closes anything, asked here before anything is recorded. The
refusals, in the order they are asked:

| It happened | Code |
| --- | --- |
| Called from another pane, from outside a pane, or with a `--task-id` that is not that Dispatch's | `sender_mismatch` |
| Named a Dispatch that does not exist | `dispatch_not_found` |
| The pane is gone | `stale_dispatch` |
| The pane answers with a different pty or epoch, or corral cannot observe it at all | `sender_mismatch` |
| The attempt was stopped, abandoned or released | `capability_revoked` |
| The attempt ended some other way and this is not a `worker_done` | `stale_dispatch` |
| A `worker_done` naming a superseded attempt | `stale_dispatch` |
| A second `worker_done`, or one for a Task that is already settled | `illegal_transition` |

Every one of them stores **nothing**: no message, no record change, and the bytes of `state.json` do not move.
`worker_done` is included: a report corral cannot place is worse than no report, because it settles the Task, so
an unobservable pane refuses it rather than recording it. Whether a report can be accepted at all — the
transition it would make, and the mailbox's own capacity — is computed **before** the receipt is admitted, so a
refused report leaves the receipt directory byte for byte as it was and its `--request-id` unspent.

That look is taken **inside the document lane the command is about to write under**, and **once per command**:
the proof a call is admitted on is never older than the write it authorises, and a pane that dies while a
command waits for the lane cannot have its call admitted on the pane it used to be. `ask` follows the same rule
as `send` — it was the one path that observed before the lane, so a question could be stored for an attempt
corral could no longer reach.

`sessionVerified` in the answer says whether the session half of that comparison was made at all, and `ask`
reports it in both the `pending` and the `answered` envelope and in the stored receipt. An attempt
started where `CORRAL_SESSION` was unset recorded no session, so there is nothing to compare a caller's against
and the pane id stands alone — a weaker proof than the usual one, and the caller is told which of the two they
got rather than left to assume the stronger.
This is proof against confusion, not authentication — anything that can already write to the 0600 runtime socket
could state any pane id. The trust boundary is that socket, which is also why coordinator-side commands carry no
proof at all.

Capability lifetime is not process lifetime. Settling, `worker-stop`, `worker-abandon` and `worker-release` each
record `capabilityRevokedAt`, and the **first** revocation is the one kept. A worker whose pane is still alive can
therefore be refused: the record says the attempt ended.

`worker_done` settles the Task and the attempt through the same `transition` table `task-update` uses, with
`settledBy: worker_done` — `succeeded` becomes `completed` and promotes dependents, `failed` becomes `failed`.
Do not follow it with `task-update`. Storing the report and settling the attempt is one value and therefore one
`rename(2)`, so the two can never disagree.

### Messages, Delivery and ACK

Messages live in the Run mailbox inside the same `state.json` the records use. Ids are `msg_<12 hex>` and
`delivery_<12 hex>`; `sequence` is monotone within a Run and is what FIFO means here. A Run holds at most 10000
messages, a body at most 65536 bytes and a subject at most 1024; reaching the ceiling is `message_capacity` —
decided before the receipt exists on **every** path that creates a message, a coordinator `status` and an `ask`
included, so a refused call leaves its `--request-id` unspent — and
corral never deletes a stored message to make room.

A Run has **at most one outstanding Delivery**. `check` hands over the oldest undelivered messages matching
`--types`, at most 50, and keeps handing back that same batch with `deliveryReplayed: true` until it is
acknowledged — a message that arrives meanwhile is never mixed in, because one Delivery id must never mean two
different sets. `--ack` accepts only the batch that is currently outstanding; an id already acknowledged, one from
an earlier batch, or one that never existed is `delivery_stale` and changes nothing. `--peek` reports what the
next batch would hold without creating one, and `inbox` lists the mailbox without consuming anything.
`deliveryReplayed` describes the batch; the `replayed` field beside it describes the `--request-id`. With
`--block`, the acknowledgement is applied **once, before the wait begins** — an ACK is an effect, and re-applying
it on every poll made the second poll refuse the batch the first had just closed, turning a wait into an error.

`ask` stores the question **before** it waits, so a timeout, a cancelled client or a runtime restart all leave it
answerable. A deadline is a normal answer — `state: pending` with the `messageId` and a `resumeCommand` — and
`--resume` keeps waiting for that same question rather than asking a second one; a question that already has an
answer returns it at once. `reply` answers once: a second one is `already_answered`, a target that is not a
question is `not_a_question`, and an id no message carries is `message_not_found` — all three effect-free. A reply is addressed to the asker and is never part of a `check`
batch.

### Waiting, and the lane

`check --block` and `ask` are the only two commands that block on another party, and the only two allowed
`--timeout-ms` up to **600000** — ten minutes, which is what a Claude Code Bash call can actually spend.
Everything else keeps the 120000 ceiling. Both drop the orchestration lane while they wait and take it again only
for the length of one write, so a coordinator blocked in `check --block` never blocks the `worker_done` it is
waiting for. That is also why the lane lives in the module rather than in the runtime's command lane: a
runtime-wide lane cannot be released across a wait. `worker-start` drops it too, around `terminal create` and
`terminal prompt`, and re-decides its plan when it comes back.

Two durability limits are worth stating. A child `terminal create`, `terminal prompt` or `terminal close` issued
by an orchestration command does not take the terminal module's own lane, so a `terminal` command run
concurrently by hand can interleave with one; each individual call is still atomic and receipted. And a
`check --block` that is interrupted leaves its `--request-id` in the pending state `request-show` reports — mint
a new one rather than retrying that one.

### Recovery

`worker-release` needs the attempt to have **ended**; an open one is `dispatch_active` and `worker-stop` is the
command that cancels it. The mirror of that is `worker-stop` on an attempt that has already ended: `dispatch_not_active`,
with `worker-release` as the recovery. The decision and the close happen inside one lane hold, with a fresh observation taken
immediately before the close, so the pane that is closed is the pane that was judged.

| Attempt | Code sees | Result |
| --- | --- | --- |
| open | — | `dispatch_active`, nothing happens |
| ended, owned, same generation | `live` | `released`, `processAction: closed` |
| ended, owned, pane gone | `pane_gone` | `retained (pane_gone)` |
| ended, owned, PTY or epoch moved | `pty_replaced` / `epoch_changed` | `retained (identity_unproven)` |
| ended, owned, backend silent | unobserved | `retained (observation_failed)` |
| ended, borrowed | anything | `retained (borrowed)` |
| ended, retain declared | anything | `retained (that reason)`, and the retain is cleared |
| already released | — | the stored release, written again nowhere |
| close accepted, removal unobserved | — | `release.state: unknown`; recover with `worker-show`, never a second close |

Ownership moves. `worker-start --terminal` on a pane a settled attempt owns transfers it: that attempt becomes
`borrowed` and names the new one in `ownershipTransferredTo`, so releasing the old attempt no longer closes a
pane the new worker is using. A **retained** attempt still owns its pane and hands it over the same way — only a
`released` release ends ownership, and a retain is precisely the case where the attempt is over and the pane is
still there. A pane no attempt owns — one a person started with `terminal create --agent` — is `borrowed` from
the start and corral never closes it.

Whether a pane is busy is a different question from who may close it, and the two are asked separately. Any
Both questions are asked again **inside the write itself**, on the document that write is made on, so two
`worker-start` calls racing for one pane leave one attempt and one owner rather than two — the losing call
reports `state: failed` at stage `dispatch` with `stages.dispatch.error: dispatch_active` and creates nothing.
(That refusal is past the receipt, unlike the others: a race is not something preflight can foresee.)

Any **open** attempt bound to that pane refuses the re-use with `dispatch_active`, borrowed attempts included:
hanging that refusal off ownership answered "nobody is here" for every borrowed pane, which let a second Task be
started on top of a running one.

`worker-retain --reason user_requested|user_takeover` is intent only; no process is touched. corral does not
detect a takeover on its own, because it has no GUI to detect one from. `worker-stop` demands the strongest
proof there is — the attempt is open, this attempt owns the pane, and the pane observed right now is the same
generation — and does nothing at all otherwise (`identity_unproven`): a stop that might have closed the wrong pane
is worse than a stop that refused. `worker-abandon` takes no process action whatsoever, settles the attempt
`failed (abandoned)`, revokes the capability and records the resource as `retained (abandoned)`.

`unknown` is still reconcile's alone: `worker-stop` and `worker-abandon` settle `failed`, because both are
outcomes corral observed and intended.

`worker-show` observes the pane whether or not the attempt has ended. `observation.live` is what the pane says
right now and `observation.record` carries the reconcile reason and time the document already held; the two are
different facts and neither stands in for the other. Whether a settled attempt's pane survived it is the
difference between a transcript still open in front of you and nothing left to read, so answering `live: null`
because the attempt was over reported the record's own age as if it were an observation. The look is read-only:
`worker-show` reconciles nothing, settles nothing, and reports the Task the document already held.

`worker-list --status` filters on the **Dispatch** status and takes only a Dispatch word — `dispatched`,
`completed`, `failed`, `unknown`. The Task words `ready` and `blocked` are refused here rather than accepted into
a filter no row could ever match.

## Profiles and targets

`CORRAL_USER_DATA` selects an isolated profile; default is the desktop userData directory. `CORRAL_RUNTIME_SOCKET` or `--socket /absolute/private/path/rpc.sock` selects its socket. An explicit socket overrides the environment. Socket and parent must belong to the current user and have private permissions (socket 0600, parent 0700). Paths must fit 100 UTF-8 bytes. `CORRAL_CLI_SOCKET` is not a legacy fallback.

`status`, `open` and `diagnostics memory` accept `--instance <runtimeId>` from status. This identifies the persistent profile; status also returns a per-process `instanceId` and PID which change on restart. Wrong identities fail before effects; `open --instance` does not create a missing runtime. `--timeout-ms 1..120000` bounds client waiting (default 10 seconds; open 20 seconds). SIGINT/SIGTERM cancel waiting; a lost response returns `outcome_unknown`. Cancellation or timeout cannot undo an already accepted desktop launch. The client never automatically retries a mutation.

`serve` owns the foreground local RPC runtime and exits cleanly on SIGINT/SIGTERM. `open` focuses an existing desktop, starts one when stopped, or asks serve to release ownership and starts the desktop on the same profile. `runtime.state=ready` means the RPC runtime is ready; `ui.available` distinguishes a desktop window. It does not imply a backend is connected. Desktop backend connection remains visible through the GUI's existing link state.

## Backend and measurement scope

This slice does not install, patch, start or stop herdr. Existing desktop session discovery remains supported. To preserve a specific externally started backend through headless-to-desktop handoff, set **both** `CORRAL_BACKEND_SOCKET` and `CORRAL_SESSION` when starting serve. Their binding is saved in the profile and restored by desktop; conflicting later values fail. The backend process and its PTYs remain independently owned. A new profile is needed to bind a different backend; there is no implicit migration or session deletion.

`diagnostics memory` runs `ps` in the selected runtime and reports RSS bytes, CPU percent, main/renderer/other process totals and collection time. Scope covers the runtime, descendants and Electron's process-role PIDs. Independent backend and terminal processes are explicitly excluded; no worktree attribution is claimed. Host memory uses OS free memory (not reclaimable-memory estimation). Missing runtime, failed `ps`, or a missing runtime PID returns an error rather than zero. CPU is the `ps` sample, not a new interval measurement.

## Reproduce isolated verification

Run with Node 22 on PATH (from `app/`):

```
TMPDIR=/tmp npx vitest run
```

The LIFE-391 acceptance harnesses (`cli-verify.mjs`, `gui-verify.mjs` — installed herdr 0.9.0, isolated XDG configuration and named backend, actual Electron input, screenshots and trusted Chromium IME events) were removed from this repository in LIFE-717; they were one-off gate scripts and are kept with that task's private work records.

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
