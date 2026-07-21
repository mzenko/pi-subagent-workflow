# Orchestration patterns

This is the guide the philosophy points to: recurring orchestration shapes live here as prose and runnable examples, not as hard-coded agent types. Nothing below is a bundled feature - each pattern is just a way to compose the `subagent` and `workflow` primitives. When a shape proves itself on a real task, save that run (`/workflow-save`) and reuse it immediately as `script: "@<name>"`. Its `/wf-<name>` command is registered immediately when the host permits runtime registration, or in the next pi session; the pattern earned its keep.

Every workflow example runs against the shipped API: the globals `agent`, `parallel`, `pipeline`, `phase`, `log`, and `args`. `agent()` resolves to a schema-validated value when a `schema` is set, to the final text otherwise, and to `null` on failure - so guard for `null` and filter it out of fan-ins. An isolated call is the one exception: it returns `{ value, patch, changed }` so the worktree changes survive orchestration.

`parallel()` and `pipeline()` preserve `agent()` failures as `null`, but they do not swallow JavaScript errors from user thunks or stages. A thrown callback rejects the helper and fails the workflow. Both helpers accept an optional `{ concurrency }` bound (`parallel(thunks, options)` and `pipeline(items, options, ...stages)`); omit it for full fan-out.

A note that recurs below: because scripts are deterministic, all variability enters through `args`. There is no `Date.now`, `Math.random`, or `fetch` in a workflow body. When a script needs a Date, pass a varying numeric epoch-millisecond value through `args` and use `new Date(args.epochMs)`, or derive a number with `Date.UTC` and pass it to `new Date`; `Date.parse` and string Date inputs are rejected.

---

## 1. Adversarial verification

**When to use.** A worker produces something (a change, an answer, a plan) and you do not want to trust its own self-report. A second, independent agent with no memory of how the first one talked itself into its answer checks the result against the original task.

**Shape.** Draft, then verify. The verifier gets the task and the reported result, not the drafter's session, so it cannot inherit the drafter's blind spots.

```js
export const meta = {
  name: 'adversarial-verify',
  description: 'Draft a change, then independently verify it',
  phases: [{ title: 'Draft' }, { title: 'Verify' }],
}

const draft = await agent(`Implement this and report exactly what you changed:\n${args.task}`)
if (!draft) return { ok: false, issues: ['drafting agent failed'] }

phase('Verify')
const verdict = await agent(
  `Task: ${args.task}\n\nAnother agent reported this result:\n${draft}\n\n` +
    'Independently verify it is correct and complete. Do not assume the report is accurate.',
  {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
      required: ['ok'],
    },
  },
)
return verdict ?? { ok: false, issues: ['verifier failed'] }
```

**Failure modes.**

- **Shared blind spot.** If you give the verifier the drafter's reasoning verbatim, it anchors on it. Pass only the task and the concrete artifact.
- **Verifier optimism.** Small models tend to answer `ok: true`. Make the schema demand evidence (`required: ['ok', 'evidence']`) so a rubber-stamp costs the model something.
- **A `null` draft.** The drafter can fail; the guard above turns that into an honest negative verdict instead of a crash.

---

## 2. Judge panel

**When to use.** You want a score or a decision on one artifact and a single opinion is too noisy. Fan out several judges - each a different rubric or persona passed through `args` - over the same artifact, then aggregate.

**Shape.** One `parallel()` barrier, one aggregation. The judges are independent, so this is pure fan-out; no judge feeds another.

```js
export const meta = {
  name: 'judge-panel',
  description: 'Score one artifact with an independent panel of judges',
}

const scored = await parallel(
  args.judges.map((lens) => () =>
    agent(
      `Evaluate strictly through this lens: ${lens}\n\nRubric:\n${args.rubric}\n\nArtifact:\n${args.artifact}`,
      {
        schema: {
          type: 'object',
          properties: { score: { type: 'number' }, rationale: { type: 'string' } },
          required: ['score', 'rationale'],
        },
      },
    ),
  ),
)

const valid = scored.filter(Boolean)
const mean = valid.length ? valid.reduce((sum, s) => sum + s.score, 0) / valid.length : null
return { panelSize: valid.length, mean, scores: valid }
```

**Failure modes.**

- **Correlated judges.** Identical prompts give you one opinion N times. The variation must live in `args.judges` (distinct lenses), or the panel is theatre.
- **Silent shrinkage.** A judge that fails resolves to `null` and `filter(Boolean)` drops it - a five-judge panel can quietly become three. Report `panelSize` so the caller sees it.
- **`Math.random` reflex.** If you reach for jitter or a random tie-break, remember it is blocked. Seed any randomness through `args`.

---

## 3. Loop-until-dry

**When to use.** A harvesting task - find every TODO, every dead link, every unhandled error - where one pass misses things and you want to keep going until a pass turns up nothing new.

**Shape.** A `while` loop whose exit conditions are deterministic: an empty batch or an explicit round cap from `args`.

```js
export const meta = {
  name: 'loop-until-dry',
  description: 'Harvest findings in rounds until a pass is empty or the round cap is reached',
}

const findings = []
let round = 0

while (round < args.maxRounds) {
  const batch = await agent(
    `Round ${round + 1}. Already found (do not repeat):\n${JSON.stringify(findings)}\n\n` +
      `Find NEW ${args.target} only.`,
    {
      schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
    },
  )
  const items = batch?.items ?? []
  if (items.length === 0) break
  findings.push(...items)
  round++
  log(`round ${round}: +${items.length} (total ${findings.length})`)
}

return findings
```

**Failure modes.**

- **Non-convergence.** If the agent keeps re-reporting known items, `findings` grows and never empties. Feeding the running list back in (as above) plus a round cap bounds it.
- **Resume cost.** Each round is one journaled `agent()` call, so resume replays completed rounds cheaply - but only if the loop's control flow is a pure function of `args` and past results. Do not branch on anything nondeterministic.

---

## 4. Multi-angle drafting

**When to use.** A single draft is narrow. Draft the same thing from several angles in parallel, then have one synthesizer merge the strongest parts.

**Shape.** Fan-out of drafts, then a single synthesis phase that consumes them.

```js
export const meta = {
  name: 'multi-angle-draft',
  description: 'Draft from several angles in parallel, then synthesize one version',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const drafts = await parallel(
  args.angles.map((angle) => () => agent(`Draft "${args.topic}" emphasizing: ${angle}`)),
)

phase('Synthesize')
const usable = drafts.filter(Boolean)
if (usable.length === 0) return null

const merged = await agent(
  'Merge these drafts into one strong version, keeping the best of each:\n\n' +
    usable.map((draft, i) => `--- Draft ${i + 1} ---\n${draft}`).join('\n\n'),
)
return merged
```

**Failure modes.**

- **Bland averaging.** A synthesizer told only to "merge" often regresses to the mean. Ask it to *keep the best of each and cut the rest*, and give it the angles so it knows what each draft was for.
- **Context blow-up.** Concatenating many long drafts into one synthesis prompt can exceed the model's window. For large fan-ins, `schema` each draft down to its key points first, then synthesize the structured summaries.
- **All-null fan-out.** If every drafter fails, `usable` is empty; the guard returns `null` rather than sending an empty prompt.

---

## 5. Migrate, with a worktree note

**When to use.** A mechanical change applied across many files - a rename, an import rewrite, an API migration. You discover the file list, then apply the change file by file.

**Shape.** Discover, then fan out **isolated** editors with `isolation: "worktree"`: each editing agent works in its own temporary git checkout and returns its changes as a patch. Nothing touches the shared tree until you review and apply the patches.

```js
export const meta = {
  name: 'migrate-modules',
  description: 'Apply a mechanical migration across files in isolated worktrees',
  phases: [{ title: 'Plan' }, { title: 'Migrate' }],
}

const plan = await agent(`List every file that needs this change: ${args.change}`, {
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})

phase('Migrate')
const results = await parallel(
  (plan?.files ?? []).map((file) => () =>
    agent(`Apply "${args.change}" to ${file}. Report what you changed.`, { isolation: 'worktree', label: file }),
  ),
)
return results.filter(Boolean)
```

Each non-null result is `{ value, patch, changed }`: `value` is the child's final text or structured output, `patch` is a unified diff including untracked files, and `changed` lists touched paths. Review and apply patches explicitly - `git apply` per patch, resolving overlaps yourself. Nothing is committed or auto-applied.

**The apply idiom.** Write each patch to a file and check it before applying; do not pipe patch text through shell interpolation (quoting mangles it):

```bash
# result.patch was saved to /tmp/child-core.patch (write the string with your
# file-writing tool, not echo/heredoc interpolation)
git apply --check /tmp/child-core.patch && git apply /tmp/child-core.patch
```

Apply patches one at a time in a deliberate order; after each apply, the next `--check` tells you immediately if an overlap conflicts. `git apply --3way` can merge mild overlaps but leaves conflict markers - only use it when you intend to resolve them.

**Failure modes.**

- **Overlapping patches.** Two editors touching the same file produce patches that conflict at apply time. Partition the work so each child owns disjoint files (as above), or fall back to a sequential `for` loop of `await`s when edits genuinely overlap.
- **Not a git repo.** Worktree isolation fails closed: a child whose cwd is not a git repository fails with a clear error rather than silently editing the shared tree. That is a feature; do not "fix" it by dropping isolation on writers.
- **Nested cwd.** If `cwd` points inside a repository, the isolated child starts at the corresponding repo-relative directory inside its worktree, not at the repository root.
- **Discovery drift.** If discovery misses files, the migration is silently partial. Have the plan agent return counts or globs you can sanity-check, and treat a `null` plan as "abort".
- **Non-idempotent edits.** On resume, completed file edits replay from the journal (no re-edit), but the patches from replayed calls still need applying exactly once. Track what you have applied.
