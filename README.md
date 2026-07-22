# pi-subagent-workflow

[![npm version](https://img.shields.io/npm/v/pi-subagent-workflow)](https://www.npmjs.com/package/pi-subagent-workflow)

Ad-hoc subagents and scripted workflow orchestration for [pi](https://github.com/earendil-works/pi).

No personas, no registries. A **subagent** is a per-call spec (prompt, model, tools) run as its own pi process. A **workflow** is deterministic JavaScript that composes those same subagents into phases, pipelines, and fan-outs, with a journal that makes runs resumable. Recurring shapes (adversarial verification, judge panels, loop-until-dry) live as [patterns](docs/patterns.md), not built-in agent types.

Requires pi `>= 0.80.6`. No native dependencies.

## Install

```sh
pi install npm:pi-subagent-workflow
# or from GitHub:
pi install git:github.com/mzenko/pi-subagent-workflow
# or, for local development:
pi install /path/to/pi-subagent-workflow
```

Registers the `subagent` and `workflow` tools, the `/agents` navigator, and the saved-workflow commands.

## `subagent`

Spawn one child, or fan out up to 16 in a single call. Children start cold with only their prompt and run in the background by default; the result arrives as a steered message.

| Field | Meaning |
|---|---|
| `prompt` | The task. Required for a single child. |
| `model` | `"provider/model-id"`. Inherits the parent's when unset. |
| `thinkingLevel` | `off`…`max`. Inherits when unset. |
| `schema` | JSON Schema requiring structured output (validated; one repair attempt on a miss). |
| `isolation` | `"worktree"` runs in a temp git worktree; changes return as a patch, never auto-applied. |
| `specs` | Array (≤16) for a fan-out. One dead child never kills the batch. |
| `followUp` | `{ id, prompt }` forks a completed child's session into a new run. |
| `wait` | `true` blocks and returns inline; default is background delivery. |

Concurrency across all spawns is bounded by one global semaphore (`/workflow-settings` to change). `tools`/`excludeTools` narrow the child's toolset; `subagent` and `workflow` are always excluded.

## `workflow`

A JavaScript module with a literal `meta` header and a top-level-`await` body:

```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit route handlers for missing auth',
  phases: [{ title: 'Discover' }, { title: 'Audit' }],
}

const found = await agent('List route files under src/', {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})
phase('Audit')
const audits = await parallel(found.files.map((file) => () => agent(`Audit ${file} for missing auth`)))
return audits.filter(Boolean)
```

Globals: `agent(prompt, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(msg)`, `args`. Scripts run in a deterministic VM (no wall-clock, randomness, or I/O; variability enters through `args`), and each `agent()` call is journaled so `resumeRunId` replays completed work. Full authoring guidance ships as the on-demand `workflow-authoring` skill.

Save a run that proved itself with `/workflow-save`; reuse it as `script: "@<name>"` or the generated `/wf-<name>` command.

## `/agents`

`/agents` (alias `/workflows`) opens an overlay of runs for the current cwd: run list → run detail → agent transcript, with live runs pinned. Running children stream their in-flight assistant message into the transcript and take steers from an inline composer; on an eligible completed child the same composer sends a follow-up message instead, forking the persisted session into a fresh child whose reply streams live and is shown only to you (never queued to the parent model). Children sort alphabetically by label so rows keep their place as queued workers start. `/workflow-settings` edits concurrency, timeout, and approval policy.

<details>
<summary>Reference: workflow globals, catch-up semantics, and operational caveats</summary>

- `agent(prompt, opts?)` - run one subagent. `opts` mirrors the subagent spec minus the prompt: `model`, `thinkingLevel`, `tools`, `excludeTools`, `schema`, `cwd`, `isolation`, `label`, and `phase`. Options are runtime-validated before replay or spawn. An explicit `tools` list is a capability contract: any requested name that does not resolve to an active tool fails the child's spawn with a diagnostic naming the missing tools, rather than silently running without them. Normally returns the schema-validated value when a schema is set, else the final text. With `isolation: "worktree"`, it returns `{ value, patch, changed }`, where `value` is that normal result. Patches have a conservative internal inline size limit; an oversized diff fails collection and retains the worktree instead of entering the journal or workflow worker. On child failure it resolves to `null` (it never throws). Failed calls remain in the run event log but are deliberately not journaled, so resume retries them. Calls start eagerly, but each root or branch scope may have only one call in flight; use `parallel` or `pipeline` for concurrency. Workflow and branch completion drain unawaited calls, including calls started by promise continuations.
- `parallel(thunks, options?)` - an explicit barrier. Starts an array of `() => Promise` thunks concurrently and preserves result order. Normally omit `concurrency`: the process-wide semaphore already enforces the configured global admission limit. Pass `{ concurrency: 4 }` only when this branch group should intentionally stay below that limit. Host agent calls run concurrently up to the helper and global bounds, while their continuations resume in accepted call order so provider timing cannot change shared state. An `agent()` failure produces `null`; JavaScript errors thrown by a thunk reject the barrier after all launched branch work settles.
- `pipeline(items, options?, ...stages)` - starts each item concurrently and runs it through the stages `(item, previous) => ...`. Normally omit `options` so the process-wide semaphore governs admission. Pass `{ concurrency }` immediately after `items` only when this pipeline should intentionally stay below the global limit. Agent-dependent continuations resume in accepted call order, so a slow earlier call can delay later continuations without delaying already-admitted host calls. An `agent()` failure produces `null`; JavaScript errors thrown by a stage reject the pipeline after all launched branch work settles.
- `phase(title)` - sets the current phase for subsequently created agents. It is available only at an idle workflow root; use `opts.phase` inside `parallel`/`pipeline` branches.
- `log(message)` - a narrator line, persisted as a run event and streamed to the live UI. `console.log` is aliased to it.
- `args` - the tool-call-provided args value, deep-frozen. Timestamps and randomness must enter through here (see below). Omitting args during resume reloads the original `args.json`; passing an explicit value, including `null`, overrides it.

Per-run backstops: a fixed lifetime cap of 200 agents for every new workflow (exceeding it is a clear error naming the cap and count), an optional model-prompt wall timeout, and the shared global concurrency semaphore. An older run with a persisted `maxAgentsPerWorkflow` policy keeps that cap on resume; a run with no persisted policy uses 200.

### Determinism, and why

The script runs in a constrained VM realm inside a disposable worker. Runtime guards block `Date.now`, `Date.parse`, Date construction without exactly one primitive finite epoch-millisecond number, local-time and locale-sensitive formatting, `Intl`, `Math.random`, raw Promise concurrency, completion-order races, proxies, nested realms, error stack frames, garbage-collection observation, timers, `process`, `require`, `fetch`, `SharedArrayBuffer`, `Atomics`, and `WebAssembly`; dynamic `import` is rejected while parsing the script. Use `parallel` or `pipeline` instead of overlapping calls or `Promise.all`/`allSettled`/`race`/`any`, so concurrent calls receive stable branch identities and agent results resume in accepted call order. Helper inputs must be dense ordinary arrays with data elements; accessors, sparse arrays, and custom prototypes are rejected before any branch starts, while own method overrides are ignored. Construct Dates as `new Date(epochMs)`, where `epochMs` is any primitive finite number, including a value returned by `Date.UTC`; string inputs, Date objects, component arguments, and `Date.parse` are rejected. Any timestamp that varies between runs must enter through `args`. A two-stage worker watchdog preempts blocking native calls and infinite loops even after an `await`. A responsive worker waiting unusually long for child/tool work emits one diagnostic with the child ID and latest activity without terminating it; the configured agent timeout remains the enforcement boundary for model calls.

Each `agent()` call is journaled by its deterministic async-lineage identity, a hash of its resolved prompt, options, and phase, and a fingerprint of its resolved execution environment: provider, model, thinking level, cwd, and the statically declared tool names of the extensions discovered for the child's authored cwd. The fingerprint verifies declared capability shape, not implementation identity or runtime behavior; repository contents (including what a worktree-isolated child of a dirty checkout sees), extension implementation digests, Pi versions, and tools an extension registers dynamically during session start are deliberately outside it. Interpolate authored state such as a repository revision into the prompt when it must participate in replay identity. The identity records its operation within the root workflow or a specific nested `parallel`/`pipeline` item, so child completion order cannot swap cached results. Resume re-executes from the top and replays matching entries. A miss invalidates only its causal tail and descendants; completed sibling branches remain reusable. If the script could observe wall-clock time, host locale, randomness, or unscoped completion order, replay could diverge. Pass timestamps and seeds through `args`, and use the provided concurrency helpers.

The script is validated at the launch boundary before any execution: it is parsed, the literal `meta` header is checked (`name` must be kebab-case, `description` required, `phases` optional), and args that arrive as a JSON string are parsed defensively. A malformed script or bad meta fails with a clear error naming the line - never a crash inside the body.

### Launch approval

In the TUI, launching a workflow shows an approval dialog with its name, description, and phases. Choices are **Run once**, **Always for this workflow in this project** (offered only for saved workflows), **View script** (a scrollable overlay), **Open in editor** (inspection only; edits are discarded and do not change the launch), and **Deny** (a clear error the model can relay). "Always" consent is recorded per workflow name, project cwd, and exact script hash, so editing or replacing a saved workflow requires approval again. Non-TUI modes (`json` / `print` / `rpc`) auto-approve - a headless caller already made an explicit tool call. The `workflowApproval` setting can instead force every TUI launch to prompt or auto-approve every workflow. Enabling auto-approval through the settings UI requires a confirmation dialog, and auto-approved launches are marked in the parent transcript.

### Settings

Run `/workflow-settings` (alias `/subagent-settings`) for the interactive editor. `/workflow-settings show`, `reload`, `reset`, and `clear-approvals` provide direct maintenance actions. Settings changes are observed immediately according to the semantics below and are stored at `~/.pi/agent/subagent-workflow/settings.json` with mode `0600`.

| Setting | Default | Range / meaning |
|---|---:|---|
| `maxConcurrentAgents` | `"auto"` | `"auto"` or 1-64; process-wide admission limit. |
| `workflowApproval` | `"remember"` | `"always-prompt"`, `"remember"`, or `"auto"`. |
| `agentTimeoutMinutes` | `0` | 0 disables it; otherwise 1-240 minutes per newly admitted child prompt. |
| `showStatusWidget` | `true` | Show or hide active workflows and subagent runs below the editor; the active-run row cap is one quarter of terminal height, with a fallback of 6 when height is unavailable. |

The settings file uses schema v4 and contains exactly these four keys plus `version`. A strictly valid v2 or v3 file is migrated to v4 in place once, with a single notice (the deleted keys are dropped). Any other missing or unsupported version warns loudly, resets the in-memory settings to defaults, and leaves the old file unchanged; `/workflow-settings reset` or the next explicit setting change writes a complete v4 file. A malformed v4 file also loads safe defaults with a warning, but ordinary edits refuse to overwrite it; fix it manually or use `/workflow-settings reset`. Reducing concurrency does not cancel running children; it pauses new admissions until enough active work drains. Timeout changes apply only to prompts admitted afterwards. Internal VM, ownership, journal, and size safety constants are intentionally not configurable.

Workflow launch validates every string-literal `model:` value in the script against the model registry and refuses to start on an unknown id, with a near-miss suggestion; the subagent tool fails a call the same way when every spec names an unknown model, while a mixed fan-out still spawns so one bad spec cannot kill valid siblings.

### Resume

Pass `resumeRunId` to resume. Resuming with the same script replays every matching journaled call instantly. Resuming with an **edited** script is supported: unchanged call identities and payload hashes replay, while a changed call and its causal tail run live without discarding completed sibling branches. A completed call whose resolved execution environment changed does not silently replay or rerun: the resume fails closed naming the drifted fields and the childId, and can be retried with `rerunChildIds: ["<childId>"]` to authorize re-executing exactly that entry and its causal tail once (the authorization is recorded on the new generation). Journals written before v4 cannot be resumed. Run ownership is acquired atomically before any script file is changed. The original script is archived as `script.resumed-<n>.js` before the new one replaces `script.js`, so every generation stays auditable. The recovery invocation shown on failure intentionally omits args because resume reloads the persisted value.

Resume refuses a pre-lineage journal, an entry that does not match the current format, or invalid JSON before the final unterminated line, and directs you to run the workflow fresh. A torn final line is tolerated: its missing call runs again and the journal is repaired at the first miss. Workflow generation files are committed behind `generation.pending`; if a crash leaves that marker, the directory is quarantined because its files may belong to mixed generations. Resume and save refuse it. Run the workflow fresh, then delete the quarantined run directory to clean it up rather than deleting only the marker.

### Saving and reusing a run

Reuse is *earned* by a successful run, not designed up front.

- `/workflow-save [runId]` saves a completed workflow run's script (defaulting to the most recent completed run for this cwd). A dialog picks **project** scope (`.pi/workflows/<name>.js`) or **user** scope (`~/.pi/agent/subagent-workflow/workflows/<name>.js`); the script is written verbatim under a provenance header (run id, date, args used).
- Saved workflows are discovered from both scopes on session load (project wins name conflicts) and registered as `/wf-<name>` commands that pass their argument text straight through as `args`. A just-saved command is registered immediately when the host permits runtime registration; otherwise it appears in the next pi session.
- The `workflow` tool also accepts `script: "@<name>"` as a reference to a saved workflow, run with fresh `args`. This form is available immediately after saving even when command registration is deferred.

## The `/agents` navigator

`/agents` (alias `/workflows`) opens a centered overlay listing runs for the current cwd - standalone subagents, fan-outs, and workflows - with live runs pinned on top and history below. It has three levels:

- **Run list** - status, label, kind, progress, tokens, age.
- **Run detail** - a workflow expands into phases with per-phase agent groups and interleaved narrator log lines; a subagent run lists its children directly. Within a phase (and for subagent runs) children sort alphabetically by label, so rows keep their place as queued workers start.
- **Agent detail** - a bounded view of the child's transcript, live-following while running through a compact message/tool renderer or static from the persisted session file when completed or when the parent process no longer owns the child. While a child runs, the assistant message currently streaming is spliced onto the persisted transcript so tokens appear as they arrive. An inline composer sends steers to a live child; on a completed child it becomes a message composer instead - submitting forks the persisted session into a fresh follow-up child (a new run linked by `followUpOf`), switches the view to it, and shows the reply live. Replies to these direct follow-up threads are shown only to you; they are never queued to the parent model, and repeated messages chain naturally because each fork carries the full prior transcript.

Runs owned by this pi process render from a synchronous in-memory projection; non-owned runs render from durable run-directory snapshots. Completed and dead-parent runs still render from files alone, while the live runner also provides pinning, transcript following, and controls.

The normal pi footer also gets a session-scoped `WF total` status, for example `WF total ↑37.2k ↓4.1k R102.0k W8.0k $0.642`. It sums each child's recorded input, output, cache traffic, and model-specific `usage.cost.total` without changing the parent context percentage. Subscription-only child usage is marked `(sub)`, and a mix of subscription and metered children is marked `(mixed)`. Totals restore from run records when a session is resumed and count a journal-replayed child only once.

| Key | Action |
|---|---|
| `↑` / `↓` (`k` / `j`) | Move selection; scroll in the agent view |
| `PageUp` / `PageDown` | Move by one viewport; scroll by one viewport in the agent view |
| `Shift+↑` / `Shift+↓` | Scroll by one viewport in the agent view |
| `Enter` | Drill in; at the agent level, focus the steering composer when the child is live, or the message composer on an eligible completed child |
| `→` | Drill in from the run list or run detail |
| `Esc` / `←` | Back out one level; `Esc` at the run list closes the navigator |
| `x` | Stop a selected live agent or whole run (press twice in the current view) |
| `f` | Cycle the status filter (run-detail level) |
| `s` | Save a selected completed workflow's script (delegates to `/workflow-save`) |

Footer hints vary by level. Run detail shows stop and save only when the selected run supports them; agent detail shows `enter steer` while the child is live and `enter message` on a completed, non-worktree child whose session file is still present. There is deliberately no pause or restart: the runner exposes neither seam, and faking either is disallowed.

## Run storage

Every run gets a durable directory under:

```
~/.pi/agent/subagent-workflow/runs/<encoded-parent-cwd>/<runId>/
```

The cwd is encoded as a readable slug plus a 16-hex path hash, e.g. `/home/you/src/app` becomes `--home-you-src-app--2721210f9e8d1b54`. The hash keeps distinct projects whose slugs would collide (`/a/b` vs `/a-b`) in separate directories. Inside a run directory:

| File | Contents |
|---|---|
| `owner.sqlite` | OS-backed ownership lock. The owner holds an empty SQLite writer transaction for its lifetime; process death releases it automatically. |
| `owner.json` | Advisory owner metadata (`pid`, `host`, `startedAt`) for diagnostics. The SQLite lock, not this file, decides ownership. |
| `run.json` | Version 3 static record: run id, kind (`subagent` / `workflow`), createdAt, parent session id and file, per-child submitted spec + resolved spec + child session file path, captured workflow admission policy, and the delivery protocol/generation identity. Navigator follow-up runs also carry `directDelivery: true`, written before any child starts: their results were shown directly to the human, so startup catch-up never queues them to the parent model. Readers still accept legacy v2 and unversioned records for inspection and resume. |
| `status.json` | Live mutable state: run status and per-child status + usage. Written atomically (temp + rename) so a reader never sees a torn file. |
| `events.jsonl` | Append-only lifecycle: every persisted child event plus run-level markers such as created, child_added, phase, log, workflow_completed, workflow_failed, workflow_aborted, and crash_reconciled. Disposal telemetry is recorded only while the run is still owned. |
| `delivered.json` | Durable parent-delivery marker containing the parent session id, catch-up flag, and matching run generation. Inline results publish it while holding run ownership. Background results publish it only after a user `message_start` containing the queued delivery text; startup catch-up claims ownership only while checking eligibility and acknowledgement re-claims it before publication. |
| `journal.jsonl` | Workflows only: a v4 `{ v: 4, call, hash, fingerprint, result, childId }` entry per completed `agent()` call. `call` is the stable async-lineage identity used for replay. |
| `script.js`, `args.json` | Workflows only: the latest script and args, persisted for resume and save-a-run. |
| `generation.pending` | Transient workflow generation-commit marker. If left after a crash, it quarantines the directory as potentially mixed-generation and blocks resume and save. |
| `result.json` | Workflows only: the normalized workflow return value, written atomically **before** the run is marked completed so a truncated or failed background delivery never loses it. The truncation notice points here. Absent when the workflow returns nothing. |
| `sessions/` | Each child's transcript as a **real pi session file**, so pi's own tooling opens them. |
| `shim/` | Per-child spec and tool-report files for the child pi process, removed when that child exits. |

Each run has one owner process. The owner holds an OS-released SQLite writer lock in `owner.sqlite`, and liveness is determined by trying that lock; `owner.json` is advisory metadata. These files replace the old `lease.json` protocol. Run directories shared across hosts are unsupported; after verifying that no owner is active, delete stale `owner.json` to override the host guard manually.

Runs are linked back into the parent session via context-excluded custom entries (`subagent-workflow:run-started` / `:run-completed`), which render as compact transcript markers. Initial layout and ownership acquisition fail closed. Ordinary event telemetry degrades to a surfaced warning on persistence failure, while critical child admission, generation, journal, result, and delivery-marker writes fail the affected delivery path.

## Limitations (honest)

- **Each child costs a pi process.** Children run as separate pi processes in RPC mode (that is what makes their extension state, console output, and crashes genuinely isolated from the parent). Startup adds roughly a second per child and each concurrent child holds a runtime's worth of memory; the admission semaphore bounds children admitted for model work, but a terminating child's process may briefly overlap a newly admitted one during bounded disposal. Process-group containment is POSIX; on Windows disposal kills only the direct child.
- **Child cleanup has a bounded orphan window.** The runner disposes every child at completion and at normal parent shutdown: it SIGTERMs the child's process group and escalates to a group SIGKILL if the child is still alive at the grace deadline. Group signals are only sent while the child leader is alive, because a numeric process-group id can be recycled once the leader is reaped; so a grandchild that ignores SIGTERM and outlives a leader which exits during the grace window is an accepted bounded orphan rather than a target the runner would risk mis-killing. Such an orphan, and any detached child left by a hard parent crash (SIGKILL), survives only until pi's RPC mode sees stdin EOF and shuts itself down: pi closes on end-of-input, and the kernel closes the pipe when the parent dies. Orphans can therefore exist for a seconds-long window, but do not persist. Resume a workflow so its journal can replay completed work.
- **Background delivery catch-up is deliberately session-scoped.** Successful result delivery records a generation-matched `delivered.json`. If the parent process dies after a new-protocol run becomes terminal but before acknowledgement, resuming that same session in the same cwd transiently claims undelivered runs to verify eligibility - reconciling a crashed owner's stale live state to terminal statuses (a `crash_reconciled` event plus a rewritten `status.json`) before anything is delivered - and starts one model turn with a compact catch-up message. No ownership is held while the message waits: a workflow resume may supersede it by advancing the generation, and a later stale acknowledgement then refuses to publish. Other sessions and cwd values never claim those runs; inspect them through `/agents`. Legacy v2 or unversioned terminal records remain visible there but are not startup-redelivered because their delivery state cannot be distinguished safely after upgrade.
- **Agents cannot be restarted.** Start a new standalone run, or resume a workflow so its journal can replay completed work.
- **Directory-backed state is shared when parent and child use the same tree.** Use `isolation: "worktree"` when that matters - each isolated child gets its own checkout at the same repo-relative cwd, changes return as a bounded patch for explicit review (never auto-committed), and worktree creation or oversized patch collection fails closed rather than degrading to the shared tree. Oversized patch failures retain the worktree path so the only copy is not deleted.
- **The workflow VM is capability isolation, not a security sandbox.** The determinism guards remove nondeterministic and ambient-authority globals so replay is sound, and the disposable worker provides a preemption boundary; `node:vm` is not a hard security boundary. Treat workflow scripts as trusted code you (or your orchestrator) authored, not as a place to run untrusted input.
- **Upgrades are a hard ownership cutover.** This version and pre-rework versions must not run concurrently against the same state. Restart every pi session when upgrading before launching or resuming runs. Downgrading state written by this version is unsupported.

## Patterns

The recurring orchestration shapes - adversarial verification, judge panels, loop-until-dry, multi-angle drafting, and migrations - live as prose with runnable examples in [docs/patterns.md](docs/patterns.md).

</details>

## Credits

Inspired by Claude Code's subagent/workflow UX and by pi-community prior art: [`@agwab/pi-subagent`](https://github.com/AgwaB/pi-subagent) and [`QuintinShaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows). This project generalizes both around a single ad-hoc subagent primitive with persistence, journaled resume, structured output, and a native navigator.

## License

MIT
