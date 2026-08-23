// src/index.ts
import z from "@deepseek-ai/schemastery";
var name = "plan-execute";
var inject = ["commands", "subagents", "userQuestions"];
var Config = z.object({
  provider: z.string().default("spawn"),
  llmProvider: z.string().default("deepseek-official"),
  plannerModel: z.string().default("deepseek-v4-pro"),
  executorModel: z.string().default("deepseek-v4-flash"),
  reviewerModel: z.string().default("deepseek-v4-pro"),
  maxConcurrency: z.number().step(1).min(1).max(16).default(2),
  stepIntervalMs: z.number().step(1).min(0).default(800),
  maxRetries: z.number().step(1).min(0).max(5).default(2),
  review: z.boolean().default(true),
  confirm: z.boolean().default(true),
  plannerEffort: z.union(["off", "low", "high", "max"]).default("high"),
  executorEffort: z.union(["off", "low", "high", "max"]).default("off"),
  reviewerEffort: z.union(["off", "low", "high", "max"]).default("high"),
  maxDepth: z.number().step(1).min(0).max(8).default(3),
  executorTimeoutMs: z.number().step(1).min(1e4).max(6e5).default(12e4)
});
var PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "constraints"],
  properties: {
    goal: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "description"],
        properties: {
          task_id: { type: "string" },
          description: { type: "string" },
          output_format: { type: "string" },
          depend_on: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};
function textBlock(text) {
  return { type: "text", text };
}
function extractText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function parseJson(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return void 0;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu.exec(trimmed);
  if (fenced?.[1] !== void 0) {
    const parsed = parseJson(fenced[1]);
    if (parsed !== void 0) return parsed;
  }
  const object = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(trimmed);
  if (object?.[1] !== void 0) {
    try {
      return JSON.parse(object[1]);
    } catch {
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return void 0;
  }
}
function sleep(ms, signal) {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
function jitteredDelay(ms) {
  if (ms <= 0) return 0;
  const spread = ms * 0.3;
  return ms + (Math.random() * 2 - 1) * spread;
}
function topoOrder(tasks) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const indegree = new Map(tasks.map((task) => [task.task_id, 0]));
  const dependents = new Map(tasks.map((task) => [task.task_id, []]));
  for (const task of tasks) {
    for (const dep of task.depend_on ?? []) {
      if (!byId.has(dep)) continue;
      indegree.set(task.task_id, (indegree.get(task.task_id) ?? 0) + 1);
      dependents.get(dep)?.push(task.task_id);
    }
  }
  const ready = tasks.filter((task) => (indegree.get(task.task_id) ?? 0) === 0).map((task) => task.task_id);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === void 0) break;
    const task = byId.get(id);
    if (task !== void 0) ordered.push(task);
    for (const next of dependents.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }
  const seen = new Set(ordered.map((task) => task.task_id));
  for (const task of tasks) if (!seen.has(task.task_id)) ordered.push(task);
  return ordered;
}
async function spawn(ctx, config, invocation, model, effort, childEfforts, promptText, personaText, outputSchema) {
  const run2 = await ctx.subagents.start(config.provider, {
    label: `pe:${model}`,
    persona: personaText,
    prompt: [textBlock(promptText)],
    parent: invocation.agent,
    signal: invocation.signal,
    agentOptions: { provider: config.llmProvider, model },
    maxDepth: config.maxDepth,
    ...outputSchema === void 0 ? {} : { outputSchema }
  });
  childEfforts.set(run2.localAgent?.id ?? run2.id, effort);
  return run2;
}
var ExecutorTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`\u5B50\u4EFB\u52A1\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)}s\uFF09`);
    this.name = "ExecutorTimeoutError";
  }
};
async function settleWithTimeout(run2, childEfforts, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      run2.result,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExecutorTimeoutError(timeoutMs)), timeoutMs);
      })
    ]);
    return { stopReason: result.stopReason, output: result.output, timedOut: false };
  } catch (error) {
    if (error instanceof ExecutorTimeoutError) {
      return { stopReason: "aborted", output: [], timedOut: true };
    }
    return { stopReason: "error", output: [], timedOut: false, fault: error };
  } finally {
    clearTimeout(timer);
    childEfforts.delete(run2.localAgent?.id ?? run2.id);
    await run2.dispose();
  }
}
async function settle(run2, childEfforts) {
  try {
    return await run2.result;
  } finally {
    childEfforts.delete(run2.localAgent?.id ?? run2.id);
    await run2.dispose();
  }
}
var PLANNER_INSTRUCTION = [
  "\u4F60\u662F\u4EFB\u52A1\u89C4\u5212\u5668\u3002\u628A\u4E0B\u9762\u7684\u7528\u6237\u9700\u6C42\u62C6\u89E3\u4E3A\u53EF\u72EC\u7ACB\u6267\u884C\u7684\u5B50\u4EFB\u52A1\uFF0C\u8F93\u51FA\u4E25\u683C JSON\uFF0C\u7981\u6B62\u4EFB\u4F55\u989D\u5916\u89E3\u91CA\u6216 markdown \u4EE3\u7801\u5757\u3002",
  '\u7ED3\u6784\uFF1A{"goal":"\u6574\u4F53\u76EE\u6807","constraints":["\u7EA6\u675F"],"tasks":[{"task_id":"T001","description":"\u8DB3\u591F\u660E\u786E\u7684\u5355\u6B65\u6307\u4EE4","output_format":"text|json|markdown","depend_on":[]}]}',
  "\u89C4\u5219\uFF1A\u4E00\u4E2A\u5B50\u4EFB\u52A1\u53EA\u505A\u4E00\u4EF6\u4E8B\uFF1Bdepend_on \u586B\u4F9D\u8D56\u7684 task_id\uFF1B\u4E0D\u8981\u751F\u6210\u6A21\u7CCA\u6307\u4EE4\u3002",
  "\u6F84\u6E05\uFF08\u5F3A\u5236\uFF09\uFF1A\u4F60\u7684\u9996\u8981\u4EFB\u52A1\u662F\u786E\u8BA4\u76EE\u6807\uFF0C\u4E0D\u662F\u731C\u6D4B\u76EE\u6807\u3002\u82E5\u7528\u6237\u9700\u6C42\u5728\u5173\u952E\u70B9\u4E0A\u4E0D\u660E\u786E\uFF08\u76EE\u6807\u8DEF\u5F84\u3001\u6587\u4EF6\u540D\u3001\u8F93\u5165/\u8F93\u51FA\u683C\u5F0F\u3001\u9A8C\u6536\u6807\u51C6\u3001\u6280\u672F\u6808\u7B49\uFF09\uFF0C\u4F60\u5FC5\u987B\u5148\u7528 ask_user_question \u5DE5\u5177\u63D0\u51FA\u4E0D\u8D85\u8FC7 5 \u4E2A\u6700\u5173\u952E\u7684\u95EE\u9898\uFF08\u6BCF\u4E2A\u5E26\u7A33\u5B9A id\uFF09\uFF0C\u6536\u5230\u7528\u6237\u56DE\u7B54\u540E\u624D\u5141\u8BB8\u8F93\u51FA\u8BA1\u5212 JSON\u3002\u7981\u6B62\u5728\u4FE1\u606F\u4E0D\u8DB3\u65F6\u9760\u731C\u6D4B\u8F93\u51FA\u8BA1\u5212\uFF1B\u5B81\u53EF\u591A\u95EE\uFF0C\u4E0D\u53EF\u81C6\u6D4B\u3002"
].join("\n");
var EXECUTOR_INSTRUCTION = [
  "\u4F60\u662F\u4EFB\u52A1\u6267\u884C\u8005\u3002\u53EA\u5B8C\u6210\u5F53\u524D task_id \u5BF9\u5E94\u7684\u8FD9\u4E00\u4EF6\u4E8B\uFF0C\u4E0D\u8981\u64C5\u81EA\u6269\u5C55\u3001\u4E0D\u8981\u4FEE\u6539\u76EE\u6807\u3002",
  "\u9075\u5B88\u6307\u5B9A\u7684 output_format \u8F93\u51FA\u3002\u82E5\u8F93\u5165\u4FE1\u606F\u4E0D\u8DB3\uFF0C\u8F93\u51FA\uFF1AERROR:\u4FE1\u606F\u4E0D\u8DB3\u3002",
  "\u5FC5\u987B\u771F\u5B9E\u8C03\u7528\u6587\u4EF6/\u547D\u4EE4\u5DE5\u5177\u5728\u6C99\u7BB1\u5185\u5B8C\u6210\u64CD\u4F5C\uFF08\u521B\u5EFA/\u8BFB\u5199\u6587\u4EF6\u3001\u8FD0\u884C\u547D\u4EE4\uFF09\uFF0C\u4E0D\u80FD\u53EA\u5728\u56DE\u590D\u91CC\u63CF\u8FF0\u505A\u6CD5\u3002",
  "\u82E5\u76EE\u6807\u6587\u4EF6\u5DF2\u5B58\u5728\uFF0C\u5148\u8C03\u7528 read \u5DE5\u5177\u8BFB\u53D6\u5B83\uFF0C\u518D\u8986\u76D6\u5199\u5165\u3002",
  "\u82E5\u64CD\u4F5C\u88AB\u6C99\u7BB1\u62D2\u7EDD\uFF08\u5982\u76EE\u6807\u5728\u5DE5\u4F5C\u533A\u4E4B\u5916\uFF09\uFF0C\u660E\u786E\u62A5\u544A\u88AB\u62D2\u539F\u56E0\uFF0C\u4E0D\u8981\u5047\u88C5\u6210\u529F\u3002"
].join("\n");
var REVIEW_INSTRUCTION = [
  "\u4F60\u662F\u7ED3\u679C\u5BA1\u6838\u4E13\u5BB6\u3002\u5BF9\u6BD4\u539F\u59CB\u76EE\u6807\u548C\u7EA6\u675F\uFF0C\u68C0\u67E5\u6BCF\u4E2A\u5B50\u4EFB\u52A1\u7684\u4EA7\u51FA\u3002",
  '\u53EA\u8F93\u51FA JSON\uFF1A{"pass":true|false,"retry_task_ids":[],"problems":[]}\uFF0C\u4E0D\u8981\u5176\u4ED6\u6587\u5B57\u3002'
].join("\n");
function plannerPrompt(task) {
  return `\u7528\u6237\u9700\u6C42\uFF1A${task}`;
}
function executorPrompt(task, deps = []) {
  const lines = [
    `task_id: ${task.task_id}`,
    `\u4EFB\u52A1\u63CF\u8FF0\uFF1A${task.description}`,
    `\u8981\u6C42\u8F93\u51FA\u683C\u5F0F\uFF1A${task.output_format ?? "text"}`
  ];
  if (deps.length > 0) {
    lines.push("", "\u4E0A\u6E38\u4EFB\u52A1\u4EA7\u51FA\uFF08\u76F4\u63A5\u590D\u7528\uFF0C\u4E0D\u8981\u91CD\u65B0\u63A8\u5BFC\uFF09\uFF1A");
    for (const dep of deps) {
      lines.push("", `\u3010${dep.task_id}\u3011${dep.ok ? "" : "(\u8BE5\u4E0A\u6E38\u4EFB\u52A1\u5931\u8D25) "}${dep.text}`);
    }
  }
  return lines.join("\n");
}
function reviewPrompt(plan, results) {
  return JSON.stringify({ goal: plan.goal, constraints: plan.constraints, results }, null, 2);
}
async function planPhase(ctx, config, invocation, task, childEfforts) {
  const run2 = await spawn(
    ctx,
    config,
    invocation,
    config.plannerModel,
    config.plannerEffort,
    childEfforts,
    plannerPrompt(task),
    PLANNER_INSTRUCTION,
    PLAN_SCHEMA
  );
  const result = await settle(run2, childEfforts);
  if (result.stopReason !== "completed") {
    throw new Error(`planner failed: ${result.stopReason}`);
  }
  const plan = result.structured ?? parseJson(extractText(result.output));
  if (plan === void 0 || !Array.isArray(plan.tasks) || typeof plan.goal !== "string") {
    throw new Error("planner returned no parseable plan");
  }
  if (plan.tasks.length === 0) {
    throw new Error("planner returned an empty task list");
  }
  return plan;
}
async function executeOne(ctx, config, invocation, task, deps, childEfforts) {
  await sleep(jitteredDelay(config.stepIntervalMs), invocation.signal);
  const flashAttempts = config.maxRetries + 1;
  let lastFailure = "";
  for (let attempt = 0; attempt <= flashAttempts; attempt += 1) {
    if (invocation.signal.aborted) {
      return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model: "\u2014" };
    }
    const model = attempt < flashAttempts ? config.executorModel : config.plannerModel;
    const effort = attempt < flashAttempts ? config.executorEffort : config.plannerEffort;
    try {
      const run2 = await spawn(
        ctx,
        config,
        invocation,
        model,
        effort,
        childEfforts,
        executorPrompt(task, deps),
        EXECUTOR_INSTRUCTION
      );
      const result = await settleWithTimeout(run2, childEfforts, config.executorTimeoutMs);
      if (result.stopReason === "completed") {
        return { task_id: task.task_id, ok: true, text: extractText(result.output), model };
      }
      if (invocation.signal.aborted) {
        return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model };
      }
      if (result.timedOut) {
        lastFailure = `\u8D85\u65F6\uFF08${Math.round(config.executorTimeoutMs / 1e3)}s\uFF09`;
      } else if (result.fault !== void 0) {
        lastFailure = result.fault instanceof Error ? result.fault.message : String(result.fault);
      } else {
        lastFailure = `stopReason=${result.stopReason}`;
      }
    } catch (error) {
      if (invocation.signal.aborted) {
        return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model };
      }
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return { task_id: task.task_id, ok: false, text: lastFailure, model: config.plannerModel };
}
async function executePhase(ctx, config, invocation, plan, childEfforts) {
  const ordered = topoOrder(plan.tasks);
  const results = new Array(ordered.length);
  const resultById = /* @__PURE__ */ new Map();
  const done = /* @__PURE__ */ new Set();
  const dispatched = /* @__PURE__ */ new Set();
  const knownIds = new Set(ordered.map((task) => task.task_id));
  const workerCount = Math.min(Math.max(1, config.maxConcurrency), ordered.length);
  const isReady = (task) => (task.depend_on ?? []).every((dep) => !knownIds.has(dep) || done.has(dep));
  const workers = Array.from({ length: workerCount }, async () => {
    for (; ; ) {
      if (invocation.signal.aborted) break;
      let index = -1;
      for (let i = 0; i < ordered.length; i += 1) {
        const candidate = ordered[i];
        if (candidate === void 0 || dispatched.has(candidate.task_id)) continue;
        if (isReady(candidate)) {
          index = i;
          break;
        }
      }
      if (index < 0) {
        for (let i = 0; i < ordered.length; i += 1) {
          const candidate = ordered[i];
          if (candidate === void 0 || dispatched.has(candidate.task_id)) continue;
          index = i;
          break;
        }
      }
      if (index < 0) break;
      const task = ordered[index];
      if (task === void 0) break;
      dispatched.add(task.task_id);
      const deps = (task.depend_on ?? []).map((id) => resultById.get(id)).filter((result2) => result2 !== void 0);
      const result = await executeOne(ctx, config, invocation, task, deps, childEfforts);
      results[index] = result;
      resultById.set(task.task_id, result);
      done.add(task.task_id);
    }
  });
  await Promise.all(workers);
  return results;
}
async function reviewPhase(ctx, config, invocation, plan, results, childEfforts) {
  const run2 = await spawn(
    ctx,
    config,
    invocation,
    config.reviewerModel,
    config.reviewerEffort,
    childEfforts,
    reviewPrompt(plan, results),
    REVIEW_INSTRUCTION
  );
  const result = await settle(run2, childEfforts);
  if (result.stopReason !== "completed") {
    return { pass: false, retryTaskIds: [], problems: [`review failed: ${result.stopReason}`] };
  }
  const raw = parseJson(extractText(result.output));
  if (raw !== void 0 && typeof raw.pass === "boolean") {
    const retry = raw.retry_task_ids ?? raw.retryTaskIds;
    return {
      pass: raw.pass,
      retryTaskIds: Array.isArray(retry) ? retry.map(String) : [],
      problems: Array.isArray(raw.problems) ? raw.problems.map(String) : []
    };
  }
  return { pass: true, retryTaskIds: [], problems: [] };
}
function renderSummary(plan, results, verdict) {
  const succeeded = results.filter((result) => result !== void 0 && result.ok).length;
  const lines = [`/pe \u5B8C\u6210 \u2014 \u76EE\u6807\uFF1A${plan.goal}`, `\u5B50\u4EFB\u52A1 ${results.length} \u4E2A\uFF0C\u6210\u529F ${succeeded} \u4E2A`];
  for (const result of results) {
    if (result === void 0) continue;
    lines.push(`
\u3010${result.task_id}\u3011${result.ok ? "\u2713" : "\u2717"}\uFF08${result.model}\uFF09
${result.text}`);
  }
  if (verdict !== void 0) {
    lines.push(`
\u590D\u6838\uFF1A${verdict.pass ? "\u901A\u8FC7" : `\u672A\u901A\u8FC7 \u2014 ${verdict.problems.join("\uFF1B")}`}`);
  }
  return lines.join("\n");
}
function renderPlanDetail(plan) {
  const lines = [`\u76EE\u6807\uFF1A${plan.goal}`];
  if (plan.constraints.length > 0) {
    lines.push("", "\u7EA6\u675F\uFF1A");
    for (const constraint of plan.constraints) lines.push(`- ${constraint}`);
  }
  lines.push("", `\u5B50\u4EFB\u52A1\uFF08\u5171 ${plan.tasks.length} \u4E2A\uFF09\uFF1A`);
  for (const task of plan.tasks) {
    const deps = task.depend_on !== void 0 && task.depend_on.length > 0 ? `\uFF08\u4F9D\u8D56\uFF1A${task.depend_on.join(", ")}\uFF09` : "";
    lines.push(`- ${task.task_id}${deps}\uFF1A${task.description}`);
  }
  return lines.join("\n");
}
async function confirmPlan(ctx, invocation, plan) {
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: "pe_confirm",
      question: "\u8BA1\u5212\u5DF2\u751F\u6210\uFF0C\u662F\u5426\u6267\u884C\uFF1F",
      detail: renderPlanDetail(plan),
      options: [
        { label: "\u6267\u884C", description: "\u6309\u8BA1\u5212\u5E76\u884C\u6267\u884C\u5B50\u4EFB\u52A1\uFF08Pro \u89C4\u5212 \u2192 Flash \u6267\u884C \u2192 Pro \u590D\u6838\uFF09" },
        { label: "\u53D6\u6D88", description: "\u4E0D\u6267\u884C\u4EFB\u4F55\u5B50\u4EFB\u52A1\uFF0C\u7ED3\u675F\u672C\u6B21 /pe" }
      ],
      intent: { kind: "plan-review", approve: "\u6267\u884C" }
    }],
    agent: invocation.agent,
    signal: invocation.signal
  });
  const selected = answer.answers.find((item) => item.id === "pe_confirm")?.selected ?? [];
  return selected.includes("\u6267\u884C");
}
async function clarifyGoal(ctx, invocation, task) {
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: "pe_goal",
      question: "\u8BF7\u786E\u8BA4\u6211\u5BF9\u4F60\u76EE\u6807\u7684\u7406\u89E3\uFF0C\u786E\u8BA4\u540E\u624D\u5F00\u59CB\u89C4\u5212\u6267\u884C\uFF1A",
      detail: `\u4F60\u8F93\u5165\u7684\u539F\u59CB\u9700\u6C42\uFF1A
> ${task}

\u82E5\u7406\u89E3\u6709\u504F\u5DEE\u6216\u9700\u8981\u8865\u5145\u7EC6\u8282\uFF08\u76EE\u6807\u8DEF\u5F84\u3001\u8F93\u51FA\u683C\u5F0F\u3001\u9A8C\u6536\u6807\u51C6\u3001\u6280\u672F\u6808\u3001\u4F18\u5148\u7EA7\u7B49\uFF09\uFF0C\u8BF7\u76F4\u63A5\u8865\u5145\u8BF4\u660E\uFF1B\u786E\u8BA4\u65E0\u8BEF\u5219\u9009\u300C\u76EE\u6807\u5DF2\u660E\u786E\uFF0C\u7EE7\u7EED\u300D\u3002`,
      options: [
        { label: "\u76EE\u6807\u5DF2\u660E\u786E\uFF0C\u7EE7\u7EED", description: "\u6309\u4E0A\u8FF0\u7406\u89E3\u5F00\u59CB\u89C4\u5212" },
        { label: "\u76EE\u6807\u7406\u89E3\u6709\u8BEF", description: "\u4E0D\u7EE7\u7EED\uFF1B\u8BF7\u8865\u5145\u8BF4\u660E\u6216\u53D6\u6D88\u540E\u91CD\u65B0\u53D1\u9001 /pe" }
      ]
    }],
    agent: invocation.agent,
    signal: invocation.signal
  });
  const item = answer.answers.find((entry) => entry.id === "pe_goal");
  const selected = item?.selected ?? [];
  const custom = item?.custom?.trim() ?? "";
  if (selected.includes("\u76EE\u6807\u5DF2\u660E\u786E\uFF0C\u7EE7\u7EED")) {
    return task;
  }
  if (custom.length > 0) {
    return `${task}

\u3010\u7528\u6237\u8865\u5145\u3011${custom}`;
  }
  throw new Error("\u76EE\u6807\u672A\u786E\u8BA4\uFF1A\u8BF7\u91CD\u65B0\u53D1\u9001 /pe \u5E76\u7ED9\u51FA\u66F4\u6E05\u6670\u7684\u76EE\u6807\u3002");
}
async function run(ctx, config, invocation, childEfforts) {
  const task = invocation.rawInput.trim();
  if (task.length === 0) {
    return { kind: "error", text: "Usage: /pe <task description>" };
  }
  const signal = invocation.signal;
  try {
    const clarified = await clarifyGoal(ctx, invocation, task);
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    const plan = await planPhase(ctx, config, invocation, clarified, childEfforts);
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    if (config.confirm) {
      const approved = await confirmPlan(ctx, invocation, plan);
      if (!approved) {
        return { kind: "success", text: "\u5DF2\u53D6\u6D88\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u5B50\u4EFB\u52A1\u3002" };
      }
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    }
    let results = await executePhase(ctx, config, invocation, plan, childEfforts);
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    let verdict;
    if (config.review) {
      verdict = await reviewPhase(ctx, config, invocation, plan, results, childEfforts);
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      if (!verdict.pass && verdict.retryTaskIds.length > 0) {
        const retrySet = new Set(verdict.retryTaskIds);
        const retryTasks = plan.tasks.filter((task2) => retrySet.has(task2.task_id));
        const retried = await executePhase(ctx, config, invocation, { ...plan, tasks: retryTasks }, childEfforts);
        if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
        for (const item of retried) {
          const at = results.findIndex((existing) => existing.task_id === item.task_id);
          if (at >= 0) results[at] = item;
          else results.push(item);
        }
        verdict = await reviewPhase(ctx, config, invocation, plan, results, childEfforts);
      }
    }
    return { kind: "success", text: renderSummary(plan, results, verdict) };
  } catch (error) {
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    return { kind: "error", text: error instanceof Error ? error.message : String(error) };
  }
}
function apply(ctx, config) {
  const childEfforts = /* @__PURE__ */ new Map();
  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    const effort = childEfforts.get(payload.agent.id);
    if (effort === void 0) return resolved;
    return { ...resolved, reasoningEffort: effort };
  });
  ctx.commands.register({
    name: "pe",
    description: "Pro plans, Flash executes, Pro reviews \u2014 a rate-limit-friendly Plan-and-Execute pipeline",
    input: { hint: "<task description>" },
    handler: (invocation) => run(ctx, config, invocation, childEfforts)
  });
}
export {
  Config,
  apply,
  inject,
  name
};
