import { expect, test } from "bun:test";
import { executeWorkflowBody, resolveWorkerEntryUrl } from "../src/workflow/vm.js";

const api = { agent: async () => null, phase: () => {}, log: () => {}, args: { nested: { value: 1 } } };
const DATE_CONSTRUCTION_ERROR = "Date construction requires exactly one primitive finite number of epoch milliseconds. Workflow determinism requires this value to come through args for timestamps or randomness. Pass epoch milliseconds via args or use Date.UTC";

for (const [name, expression] of [
  ["Date.now", "Date.now()"],
  ["new Date", "new Date()"],
  ["Math.random", "Math.random()"],
  ["setTimeout", "setTimeout(() => {}, 1)"],
  ["process", "process.cwd()"],
] as const) {
  test(`workflow VM blocks ${name} with deterministic guidance`, async () => {
    await expect(executeWorkflowBody(`return ${expression}`, "guard", api)).rejects.toThrow(/args|determin/i);
  });
}

test("workflow VM deep-freezes args and supports top-level return", async () => {
  expect(await executeWorkflowBody("return [Object.isFrozen(args), Object.isFrozen(args.nested)]", "args", api)).toEqual([true, true]);
});

test("workflow VM exposes no advisory budget global", async () => {
  expect(await executeWorkflowBody("return typeof budget", "no-budget", api)).toBe("undefined");
});

test("workflow VM makes authored error stack frames unavailable", async () => {
  const result = await executeWorkflowBody(`
    let limitLocked = false;
    try { Error.stackTraceLimit = 10; } catch (error) { limitLocked = true; }
    let nativeStack;
    try { null.missing; } catch (error) { nativeStack = error.stack; }
    return [new Error("boom").stack, nativeStack, limitLocked];
  `, "deterministic-error-stack", api);

  expect(result).toEqual([null, null, true]);
  await expect(executeWorkflowBody(
    "const target = {}; Error.captureStackTrace(target); return target.stack",
    "blocked-capture-stack",
    api,
  )).rejects.toThrow(/captureStackTrace.*unavailable|determin/i);
});

test("workflow VM keeps injected globals from exposing a code-generating constructor", async () => {
  // The injected callables are created inside the realm, so their constructor
  // stays in-realm where code generation from strings is disabled. Confirm none
  // of them can build a callable from a (benign) source string.
  const body = `
    const callables = [agent, phase, log, parallel, pipeline];
    let built = 0;
    for (const fn of callables) {
      try { fn.constructor("return 1"); built += 1; } catch (denied) { /* code generation disallowed - expected */ }
    }
    return built;
  `;

  expect(await executeWorkflowBody(body, "constructor-chain", api)).toBe(0);
});

test("workflow agent promise methods stay in the constrained realm", async () => {
  const body = `
    const factories = [
      () => agent("then").then((value) => value),
      () => agent("catch").catch(() => null),
      () => agent("finally").finally(() => {}),
    ];
    let built = 0;
    for (const factory of factories) {
      const promise = factory();
      try { promise.constructor.constructor("return 1"); built += 1; } catch (denied) { /* expected */ }
      await promise;
    }
    return built;
  `;

  expect(await executeWorkflowBody(body, "agent-promise-constructor", api)).toBe(0);
});

test("workflow agent returns a real VM-realm Promise", async () => {
  expect(await executeWorkflowBody("return agent('identity') instanceof Promise", "agent-promise-identity", api)).toBe(true);
});

test("workflow completion drains an unawaited agent call", async () => {
  let settleAgent: (value: string) => void = () => {};
  let reportCalled: () => void = () => {};
  const called = new Promise<void>((resolve) => { reportCalled = resolve; });
  const pending = new Promise<string>((resolve) => { settleAgent = resolve; });
  const drainApi = {
    ...api,
    agent: () => {
      reportCalled();
      return pending;
    },
  };
  let finished = false;
  const execution = executeWorkflowBody("agent('slow'); return 'done'", "unawaited-drain", drainApi);
  void execution.then(() => { finished = true; }, () => { finished = true; });

  await called;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  settleAgent("slow-result");
  expect(await execution).toBe("done");
});

test("workflow completion drains follow-up calls started by then continuations", async () => {
  const calls: Array<{ prompt: string; call: unknown }> = [];
  let settleFollowUp: (value: string) => void = () => {};
  let reportFollowUp: () => void = () => {};
  const followUpCalled = new Promise<void>((resolve) => { reportFollowUp = resolve; });
  const followUpPending = new Promise<string>((resolve) => { settleFollowUp = resolve; });
  const drainApi = {
    ...api,
    agent: async (prompt: string, _options: Record<string, unknown> | undefined, call: unknown) => {
      calls.push({ prompt, call });
      if (prompt === "first") return "first-result";
      reportFollowUp();
      return await followUpPending;
    },
  };
  let finished = false;
  const execution = executeWorkflowBody(
    "agent('first').then(() => agent('follow-up')); return 'done'",
    "follow-up-drain",
    drainApi,
  );
  void execution.then(() => { finished = true; }, () => { finished = true; });

  await followUpCalled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  settleFollowUp("follow-up-result");
  expect(await execution).toBe("done");
  expect(calls).toEqual([
    { prompt: "first", call: { scope: [], operation: 0 } },
    { prompt: "follow-up", call: { scope: [], operation: 1 } },
  ]);
});

for (const [scope, body] of [
  ["root", "agent('first').then(() => null); agent('overlap').then(() => null); return 'done'"],
  ["parallel branch", "return parallel([() => { agent('first').then(() => null); return agent('overlap') }])"],
] as const) {
  test(`workflow rejects overlapping agent calls in the same ${scope} scope`, async () => {
    const prompts: string[] = [];
    const overlapApi = {
      ...api,
      agent: async (prompt: string) => {
        prompts.push(prompt);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return prompt;
      },
    };

    await expect(executeWorkflowBody(body, `overlap-${scope}`, overlapApi))
      .rejects.toThrow(/Overlapping agent.*parallel.*pipeline/i);
    expect(prompts).toEqual(["first"]);
  });
}

test("workflow overlap errors stay in the constrained realm", async () => {
  const overlapApi = {
    ...api,
    agent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return null;
    },
  };
  const escaped = await executeWorkflowBody(`
    const first = agent("first");
    let built = false;
    try {
      agent("overlap");
    } catch (error) {
      try { error.constructor.constructor("return 1"); built = true; } catch (denied) { /* expected */ }
    }
    await first;
    return built;
  `, "overlap-error-constructor", overlapApi);

  expect(escaped).toBe(false);
});

test("workflow overlap failure drains the first live call before reporting error", async () => {
  let settleAgent: (value: null) => void = () => {};
  let reportCalled: () => void = () => {};
  const called = new Promise<void>((resolve) => { reportCalled = resolve; });
  const pending = new Promise<null>((resolve) => { settleAgent = resolve; });
  const overlapApi = {
    ...api,
    agent: () => {
      reportCalled();
      return pending;
    },
  };
  let finished = false;
  const execution = executeWorkflowBody(
    "agent('first'); agent('overlap'); return 'done'",
    "overlap-error-drain",
    overlapApi,
  );
  void execution.then(() => { finished = true; }, () => { finished = true; });

  await called;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  settleAgent(null);
  await expect(execution).rejects.toThrow(/Overlapping agent.*parallel.*pipeline/i);
});

for (const [name, body, expectedPrompt, errorPattern] of [
  [
    "branch group after agent",
    "agent('root-slow'); return parallel([() => agent('branch')])",
    "root-slow",
    /Overlapping parallel.*agent|Await the current operation/i,
  ],
  [
    "agent after branch group",
    "const group = parallel([() => agent('branch-slow')]); agent('root'); return group",
    "branch-slow",
    /Overlapping agent.*branch groups|Await the current operation/i,
  ],
] as const) {
  test(`workflow rejects overlapping root operations: ${name}`, async () => {
    const prompts: string[] = [];
    const overlapApi = {
      ...api,
      agent: async (prompt: string) => {
        prompts.push(prompt);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return null;
      },
    };

    await expect(executeWorkflowBody(body, `root-operation-${name}`, overlapApi)).rejects.toThrow(errorPattern);
    expect(prompts).toEqual([expectedPrompt]);
  });
}

for (const [name, body] of [
  ["active root agent", "agent('slow'); phase('bad'); return 'done'"],
  ["parallel branch", "return parallel([() => phase('bad')])"],
] as const) {
  test(`workflow phase rejects from ${name}`, async () => {
    const phaseApi = {
      ...api,
      agent: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return null;
      },
    };
    await expect(executeWorkflowBody(body, `phase-${name}`, phaseApi))
      .rejects.toThrow(/idle workflow root|opts\.phase/i);
  });
}

test("workflow VM closes the Date.prototype.constructor bypass", async () => {
  await expect(executeWorkflowBody("return Date.prototype.constructor.now()", "date-constructor", api))
    .rejects.toThrow(/Date\.now|determin/i);
});

for (const [name, expression] of [
  ["string input", "new Date('2026-07-12T12:00:00Z')"],
  ["Date input", "new Date(new Date(0))"],
  ["object input", "new Date({ valueOf: () => 0 })"],
  ["multiple inputs", "new Date(2026, 6, 12)"],
  ["NaN input", "new Date(NaN)"],
  ["infinite input", "new Date(Infinity)"],
] as const) {
  test(`workflow VM rejects Date construction with ${name}`, async () => {
    await expect(executeWorkflowBody(`return ${expression}`, "date-input", api))
      .rejects.toThrow(DATE_CONSTRUCTION_ERROR);
  });
}

test("workflow VM blocks Date.parse", async () => {
  await expect(executeWorkflowBody("return Date.parse('2026-07-12')", "date-parse", api))
    .rejects.toThrow("Date.parse is unavailable. Workflow determinism requires this value to come through args for timestamps or randomness");
});

for (const [name, expression] of [
  ["Intl", "new Intl.DateTimeFormat().format()"],
  ["local Date getter", "new Date(0).getHours()"],
  ["local Date formatter", "new Date(0).toString()"],
  ["String localeCompare", "'a'.localeCompare('b')"],
  ["String locale casing", "'i'.toLocaleUpperCase()"],
  ["Number locale formatting", "(1234).toLocaleString()"],
  ["BigInt locale formatting", "(1234n).toLocaleString()"],
  ["Array locale formatting", "[1234].toLocaleString()"],
  ["TypedArray locale formatting", "new Uint8Array([1, 2]).toLocaleString()"],
] as const) {
  test(`workflow VM blocks host locale leak through ${name}`, async () => {
    await expect(executeWorkflowBody(`return ${expression}`, "locale-guard", api))
      .rejects.toThrow(/unavailable|timezone|Date\.UTC|determin/i);
  });
}

test("workflow VM permits deterministic UTC Date operations", async () => {
  const result = await executeWorkflowBody(`
    const epoch = Date.UTC(2026, 6, 12, 12);
    const date = new Date(epoch);
    return [new Date(0).toISOString(), epoch, date.toISOString(), date.getUTCHours()];
  `, "utc-date", api);

  expect(result).toEqual([
    "1970-01-01T00:00:00.000Z",
    1_783_857_600_000,
    "2026-07-12T12:00:00.000Z",
    12,
  ]);
});

for (const [name, body] of [
  ["Buffer", "return Buffer.alloc(1024)"],
  ["SharedArrayBuffer", "return new SharedArrayBuffer(4)"],
  ["Atomics", "return Atomics.wait(new Int32Array(4), 0, 0)"],
  ["WebAssembly shared memory", "return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer"],
  ["ShadowRealm", "return new ShadowRealm().evaluate('Date.now()')"],
  ["WeakRef", "return new WeakRef({}).deref()"],
  ["FinalizationRegistry", "return new FinalizationRegistry(() => {})"],
  ["Proxy", "return new Proxy([], {})"],
  ["Promise.all", "return Promise.all([Promise.resolve(1)])"],
  ["Promise.allSettled", "return Promise.allSettled([Promise.resolve(1)])"],
  ["Promise.race", "return Promise.race([Promise.resolve(1)])"],
  ["Promise.any", "return Promise.any([Promise.resolve(1)])"],
] as const) {
  test(`workflow VM blocks ${name}`, async () => {
    await expect(executeWorkflowBody(body, "blocking-intrinsic", api)).rejects.toThrow(/unavailable|determin/i);
  });
}

test("workflow VM blocks Atomics.wait after an await without wedging the host", async () => {
  await expect(executeWorkflowBody(
    "await agent('ready'); return Atomics.wait([], 0, 0)",
    "post-await-atomics",
    api,
    100,
  )).rejects.toThrow(/Atomics.*unavailable|determin/i);
});

test("workflow VM seals the Promise binding used by agent", async () => {
  await expect(executeWorkflowBody(
    "Promise = class Replacement {}; return agent('never')",
    "promise-binding",
    api,
  )).rejects.toThrow(/read only|readonly|Promise/i);
});

for (const [helper, body] of [
  ["parallel", "return parallel([() => { throw new Error('parallel boom') }])"],
  ["pipeline", "return pipeline([1], () => { throw new Error('pipeline boom') })"],
] as const) {
  test(`${helper} rejects the workflow when authored JavaScript throws`, async () => {
    await expect(executeWorkflowBody(body, `${helper}-throw`, api)).rejects.toThrow(`${helper} boom`);
  });
}

test("parallel observes later rejection immediately and drains an earlier slow branch", async () => {
  let finished = false;
  const drainApi = {
    ...api,
    agent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished = true;
      return null;
    },
  };
  const startedAt = Date.now();

  await expect(executeWorkflowBody(`
    return parallel([
      () => agent("slow"),
      () => { throw new Error("later boom"); },
    ]);
  `, "later-rejection-drain", drainApi)).rejects.toThrow("later boom");

  expect(finished).toBe(true);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
});

test("workflow worker preempts an infinite loop after await", async () => {
  const startedAt = Date.now();
  await expect(executeWorkflowBody(
    "await agent('ready'); while (true) {}",
    "post-await-loop",
    api,
    100,
  )).rejects.toThrow(/uninterrupted synchronous execution|timed out/i);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("workflow worker preempts a loop after attaching then to an unawaited agent", async () => {
  const hangingApi = {
    ...api,
    agent: async (prompt: string) => prompt === "ready"
      ? null
      : await new Promise<never>(() => {}),
  };
  await expect(executeWorkflowBody(
    "await agent('ready'); agent('never').then(() => {}); while (true) {}",
    "unawaited-agent-loop",
    hangingApi,
    100,
  )).rejects.toThrow(/uninterrupted synchronous execution|timed out/i);
});

test("host agent completions do not extend the blocked-worker watchdog", async () => {
  const delays: Record<string, number> = { a: 0, b: 70, c: 140, d: 210 };
  const staggeredApi = {
    ...api,
    agent: async (prompt: string) => {
      await new Promise((resolve) => setTimeout(resolve, delays[prompt] ?? 0));
      return prompt;
    },
  };
  const startedAt = Date.now();

  await expect(executeWorkflowBody(`
    return parallel([
      () => agent("a").then(() => { while (true) {} }),
      () => agent("b"),
      () => agent("c"),
      () => agent("d"),
    ]);
  `, "staggered-watchdog", staggeredApi, 100))
    .rejects.toThrow(/uninterrupted synchronous execution|timed out/i);

  expect(Date.now() - startedAt).toBeLessThan(250);
});

test("workflow worker permits a long awaited agent call", async () => {
  const slowApi = {
    ...api,
    agent: async () => await new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
  };
  expect(await executeWorkflowBody(
    "return await agent('slow')",
    "await-heartbeat",
    slowApi,
    200,
  )).toBe("done");
});

test("a recovered host event-loop stall does not convict a responsive worker", async () => {
  const blockedHostApi = {
    ...api,
    agent: async () => {
      const blockedUntil = performance.now() + 180;
      while (performance.now() < blockedUntil) {}
      return "done";
    },
  };

  expect(await executeWorkflowBody(
    "return await agent('host-block')",
    "host-event-loop-stall",
    blockedHostApi,
    100,
  )).toBe("done");
});

test("a failed worker liveness challenge names active children", async () => {
  const hangingApi = {
    ...api,
    agent: async () => await new Promise<never>(() => {}),
    describeActiveAgents: () => ["child-research (Research web sources)"],
  };

  await expect(executeWorkflowBody(
    "agent('never'); while (true) {}",
    "watchdog-child-context",
    hangingApi,
    100,
  )).rejects.toThrow(/direct liveness challenge.*child-research \(Research web sources\)/i);
});

test("a responsive worker reports stalled child tool work to diagnostics without terminating it", async () => {
  const diagnostics: string[] = [];
  const logs: string[] = [];
  const slowApi = {
    ...api,
    agent: async () => {
      await new Promise((resolve) => setTimeout(resolve, 240));
      return "eventually done";
    },
    describeActiveAgents: () => ["child-web (Research; last activity 0.1s ago: fetch_content example.org)"],
    diagnostic: (message: string) => diagnostics.push(message),
    log: (message: string) => logs.push(message),
  };

  expect(await executeWorkflowBody(
    "return await agent('slow web task')",
    "responsive-child-stall",
    slowApi,
    100,
  )).toBe("eventually done");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatch(/child\/tool work is still running.*worker remains responsive/i);
  expect(diagnostics[0]).toContain("child-web");
  expect(diagnostics[0]).toContain("fetch_content example.org");
  expect(logs).toEqual([]);
});

test("workflow worker can be aborted while workflow code is blocked", async () => {
  const controller = new AbortController();
  const execution = executeWorkflowBody(
    "await agent('ready'); while (true) {}",
    "abort-loop",
    { ...api, signal: controller.signal },
    5_000,
  );
  setTimeout(() => controller.abort(), 50);

  await expect(execution).rejects.toThrow(/stopped/i);
});

test("workflow worker rejects an already-aborted signal without starting", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await expect(executeWorkflowBody("return agent('never')", "already-aborted", {
    ...api,
    signal: controller.signal,
    agent: async () => {
      called = true;
      return null;
    },
  })).rejects.toThrow(/stopped/i);
  expect(called).toBe(false);
});

test("workflow agent call identities follow causal parallel and pipeline scopes", async () => {
  const calls = new Map<string, unknown>();
  const delays: Record<string, number> = {
    "parallel-0-a": 40,
    "parallel-1-a": 5,
    "pipeline-left-a": 30,
    "pipeline-right-a": 1,
  };
  const identityApi = {
    ...api,
    agent: async (prompt: string, _options: Record<string, unknown> | undefined, call: unknown) => {
      calls.set(prompt, call);
      const delay = delays[prompt] ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return prompt;
    },
  };

  await executeWorkflowBody(`
    await agent("root-before");
    await parallel([
      async () => { await agent("parallel-0-a"); await agent("parallel-0-b"); },
      async () => { await agent("parallel-1-a"); await agent("parallel-1-b"); },
    ]);
    await pipeline(["left", "right"],
      async (item) => agent("pipeline-" + item + "-a"),
      async (item) => agent("pipeline-" + item + "-b"),
    );
    return agent("root-after");
  `, "call-identities", identityApi);

  expect(Object.fromEntries(calls)).toEqual({
    "root-before": { scope: [], operation: 0 },
    "parallel-0-a": { scope: [{ kind: "parallel", operation: 1, branch: 0 }], operation: 0 },
    "parallel-0-b": { scope: [{ kind: "parallel", operation: 1, branch: 0 }], operation: 1 },
    "parallel-1-a": { scope: [{ kind: "parallel", operation: 1, branch: 1 }], operation: 0 },
    "parallel-1-b": { scope: [{ kind: "parallel", operation: 1, branch: 1 }], operation: 1 },
    "pipeline-left-a": { scope: [{ kind: "pipeline", operation: 2, branch: 0 }], operation: 0 },
    "pipeline-left-b": { scope: [{ kind: "pipeline", operation: 2, branch: 0 }], operation: 1 },
    "pipeline-right-a": { scope: [{ kind: "pipeline", operation: 2, branch: 1 }], operation: 0 },
    "pipeline-right-b": { scope: [{ kind: "pipeline", operation: 2, branch: 1 }], operation: 1 },
    "root-after": { scope: [], operation: 3 },
  });
});

for (const [helper, body] of [
  ["parallel", `return parallel([
    () => agent("item-0"),
    () => agent("item-1"),
    () => agent("item-2"),
    () => agent("item-3"),
    () => agent("item-4"),
  ], { concurrency: 2 })`],
  ["pipeline", `return pipeline(
    ["item-0", "item-1", "item-2", "item-3", "item-4"],
    { concurrency: 2 },
    (item) => agent(item),
  )`],
] as const) {
  test(`${helper} bounds active branches while preserving result order and branch identity`, async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: Array<{ prompt: string; call: unknown }> = [];
    const result = await executeWorkflowBody(body, `${helper}-bounded-concurrency`, {
      ...api,
      agent: async (prompt: string, _options: Record<string, unknown> | undefined, call: unknown) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push({ prompt, call });
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return prompt;
      },
    });

    expect(maximumActive).toBe(2);
    expect(result).toEqual(["item-0", "item-1", "item-2", "item-3", "item-4"]);
    expect(calls.map(({ prompt, call }) => ({
      prompt,
      branch: (call as { scope: Array<{ branch: number }> }).scope[0]!.branch,
    }))).toEqual([
      { prompt: "item-0", branch: 0 },
      { prompt: "item-1", branch: 1 },
      { prompt: "item-2", branch: 2 },
      { prompt: "item-3", branch: 3 },
      { prompt: "item-4", branch: 4 },
    ]);
  });
}

for (const [name, body, message] of [
  ["parallel zero", `return parallel([() => agent("must-not-run")], { concurrency: 0 })`, "positive safe integer"],
  ["pipeline unknown option", `return pipeline([1], { concurrency: 1, extra: true }, (item) => agent(String(item)))`, "supports only the concurrency property"],
  ["parallel accessor", `
    const options = {};
    Object.defineProperty(options, "concurrency", { get() { throw new Error("getter ran") } });
    return parallel([() => agent("must-not-run")], options);
  `, "must be a data property"],
] as const) {
  test(`${name} rejects invalid concurrency options before launching branches`, async () => {
    const prompts: string[] = [];
    await expect(executeWorkflowBody(body, name, {
      ...api,
      agent: async (prompt: string) => {
        prompts.push(prompt);
        return prompt;
      },
    })).rejects.toThrow(message);
    expect(prompts).toEqual([]);
  });
}

test("parallel then chains retain branch-local call identities", async () => {
  const calls = new Map<string, unknown>();
  const chainApi = {
    ...api,
    agent: async (prompt: string, _options: Record<string, unknown> | undefined, call: unknown) => {
      calls.set(prompt, call);
      if (prompt === "left-a") await new Promise((resolve) => setTimeout(resolve, 30));
      if (prompt === "right-a") await new Promise((resolve) => setTimeout(resolve, 1));
      return prompt;
    },
  };

  await executeWorkflowBody(`
    return parallel([
      () => agent("left-a").then(() => agent("left-b")),
      () => agent("right-a").then(() => agent("right-b")),
    ]);
  `, "then-chain-identities", chainApi);

  expect(Object.fromEntries(calls)).toEqual({
    "left-a": { scope: [{ kind: "parallel", operation: 0, branch: 0 }], operation: 0 },
    "left-b": { scope: [{ kind: "parallel", operation: 0, branch: 0 }], operation: 1 },
    "right-a": { scope: [{ kind: "parallel", operation: 0, branch: 1 }], operation: 0 },
    "right-b": { scope: [{ kind: "parallel", operation: 0, branch: 1 }], operation: 1 },
  });
});

for (const [helper, body] of [
  ["parallel", `
    const order = [];
    await parallel([
      async () => { await agent("left"); order.push("left"); },
      async () => { await agent("right"); order.push("right"); },
    ]);
    return order;
  `],
  ["pipeline", `
    const order = [];
    await pipeline(["left", "right"], async (item) => {
      await agent(item);
      order.push(item);
    });
    return order;
  `],
] as const) {
  test(`${helper} makes provider completion order unobservable to shared realm state`, async () => {
    const run = async (delays: Record<string, number>): Promise<unknown> => await executeWorkflowBody(
      body,
      `${helper}-stable-continuations`,
      {
        ...api,
        agent: async (prompt: string) => {
          await new Promise((resolve) => setTimeout(resolve, delays[prompt] ?? 0));
          return prompt;
        },
      },
    );

    expect(await run({ left: 40, right: 1 })).toEqual(["left", "right"]);
    expect(await run({ left: 1, right: 40 })).toEqual(["left", "right"]);
  });
}

for (const [helper, body] of [
  ["parallel", `
    const values = [() => agent("must-not-run")];
    let getterRan = false;
    Object.defineProperty(values, "1", { get() { getterRan = true; throw new Error("accessor ran"); } });
    let message = "";
    try { await parallel(values); } catch (error) { message = error.message; }
    return [getterRan, message];
  `],
  ["pipeline", `
    const values = ["must-not-run"];
    let getterRan = false;
    Object.defineProperty(values, "1", { get() { getterRan = true; throw new Error("accessor ran"); } });
    let message = "";
    try { await pipeline(values, (item) => agent(item)); } catch (error) { message = error.message; }
    return [getterRan, message];
  `],
] as const) {
  test(`${helper} validates every array element before launching branches`, async () => {
    const prompts: string[] = [];
    const result = await executeWorkflowBody(body, `${helper}-accessor-snapshot`, {
      ...api,
      agent: async (prompt: string) => {
        prompts.push(prompt);
        return prompt;
      },
    });

    expect(result).toEqual([false, `${helper === "parallel" ? "parallel(thunks)" : "pipeline(items)"} must be dense and contain data elements only`]);
    expect(prompts).toEqual([]);
  });
}

for (const [helper, body] of [
  ["parallel", `
    const values = [() => agent("left"), () => agent("right")];
    values.map = (callback) => [callback(values[0], 0), callback(values[0], 0)];
    return parallel(values);
  `],
  ["pipeline", `
    const values = ["left", "right"];
    values.map = (callback) => [callback(values[0], 0), callback(values[0], 0)];
    return pipeline(values, (item) => agent(item));
  `],
] as const) {
  test(`${helper} ignores overridden map and assigns unique branch identities`, async () => {
    const calls: Array<{ prompt: string; call: unknown }> = [];
    const result = await executeWorkflowBody(body, `${helper}-intrinsic-iteration`, {
      ...api,
      agent: async (prompt: string, _options: Record<string, unknown> | undefined, call: unknown) => {
        calls.push({ prompt, call });
        return prompt;
      },
    });

    expect(result).toEqual(["left", "right"]);
    expect(calls).toEqual([
      { prompt: "left", call: { scope: [{ kind: helper, operation: 0, branch: 0 }], operation: 0 } },
      { prompt: "right", call: { scope: [{ kind: helper, operation: 0, branch: 1 }], operation: 0 } },
    ]);
  });
}

test("workflow VM worker entry loads under plain Node", async () => {
  // vm.ts is a worker entry (new Worker(import.meta.url)): the worker thread
  // escapes the host's TS loader, so plain Node type stripping must be able to
  // resolve its whole module graph. Bun remaps .js specifiers to .ts files and
  // masks resolution failures Node reports as ERR_MODULE_NOT_FOUND.
  const vmModuleUrl = new URL("../src/workflow/vm.ts", import.meta.url).href;
  const script = `
    const { executeWorkflowBody } = await import(${JSON.stringify(vmModuleUrl)});
    const api = { agent: async (prompt) => "echo:" + prompt, phase: () => {}, log: () => {}, args: null };
    const result = await executeWorkflowBody("return await agent('ping')", "node-entry", api);
    if (result !== "echo:ping") throw new Error("unexpected result: " + JSON.stringify(result));
  `;
  // Dynamic import() from a --eval string fails with ERR_INPUT_TYPE_NOT_ALLOWED,
  // so run the probe from a real file.
  const entryPath = `${import.meta.dir}/.node-entry-probe.mjs`;
  await Bun.write(entryPath, script);
  const proc = Bun.spawn(["node", entryPath], { stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`node run failed (code ${exitCode}):\n${stderr}`);
  } finally {
    proc.kill();
    await proc.exited;
    await Bun.file(entryPath).unlink();
  }
});

test("worker entry stays on source outside node_modules", () => {
  const source = "file:///home/dev/pi-subagent-workflow/src/workflow/vm.ts";
  expect(resolveWorkerEntryUrl(source, () => true).href).toBe(source);
});

test("worker entry redirects to compiled JS under node_modules", () => {
  const source = "file:///app/node_modules/pi-subagent-workflow/src/workflow/vm.ts";
  expect(resolveWorkerEntryUrl(source, () => true).href).toBe(
    "file:///app/node_modules/pi-subagent-workflow/dist/src/workflow/vm.js",
  );
});

test("worker entry keeps source when compiled worker is missing or module is already JS", () => {
  const tsSource = "file:///app/node_modules/pi-subagent-workflow/src/workflow/vm.ts";
  expect(resolveWorkerEntryUrl(tsSource, () => false).href).toBe(tsSource);
  const jsSource = "file:///app/node_modules/pi-subagent-workflow/dist/src/workflow/vm.js";
  expect(resolveWorkerEntryUrl(jsSource, () => true).href).toBe(jsSource);
});
