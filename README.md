# pi-subagent-workflow

Ad-hoc subagents and scripted workflow orchestration for [pi](https://github.com/earendil-works/pi).

No personas, no registries. A **subagent** is a per-call spec (prompt, model, tools) run as its own pi process. A **workflow** is deterministic JavaScript that composes those same subagents into phases, pipelines, and fan-outs, with a journal that makes runs resumable. Recurring shapes (adversarial verification, judge panels, loop-until-dry) live as [patterns](docs/patterns.md), not built-in agent types.

Requires pi `>= 0.80.6`. No native dependencies.

## Install

```sh
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

`/agents` (alias `/workflows`) opens an overlay of runs for the current cwd: run list → run detail → agent transcript, with live runs pinned and a steering composer for running children. `/workflow-settings` edits concurrency, timeout, and approval policy.

## Credits

Inspired by Claude Code's subagent/workflow UX and by pi-community prior art: [`@agwab/pi-subagent`](https://github.com/AgwaB/pi-subagent) and [`QuintinShaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows). This project generalizes both around a single ad-hoc subagent primitive with persistence, journaled resume, structured output, and a native navigator.

## License

MIT
