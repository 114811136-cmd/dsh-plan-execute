// src/index.ts
import z from "@deepseek-ai/schemastery";
var name = "plan-execute";
var inject = ["commands", "subagents", "userQuestions"];
var childSessions = /* @__PURE__ */ new Set();
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
  maxDepth: z.number().step(1).min(0).max(8).default(3)
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
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return void 0;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function spawn(ctx, config, invocation, model, promptText, personaText, outputSchema) {
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
  childSessions.add(run2.localAgent?.id ?? run2.id);
  return run2;
}
async function settle(run2) {
  try {
    return await run2.result;
  } finally {
    childSessions.delete(run2.localAgent?.id ?? run2.id);
    await run2.dispose();
  }
}
var PLANNER_INSTRUCTION = [
  "\u4F60\u662F\u4EFB\u52A1\u89C4\u5212\u5668\u3002\u628A\u4E0B\u9762\u7684\u7528\u6237\u9700\u6C42\u62C6\u89E3\u4E3A\u53EF\u72EC\u7ACB\u6267\u884C\u7684\u5B50\u4EFB\u52A1\uFF0C\u8F93\u51FA\u4E25\u683C JSON\uFF0C\u7981\u6B62\u4EFB\u4F55\u989D\u5916\u89E3\u91CA\u6216 markdown \u4EE3\u7801\u5757\u3002",
  '\u7ED3\u6784\uFF1A{"goal":"\u6574\u4F53\u76EE\u6807","constraints":["\u7EA6\u675F"],"tasks":[{"task_id":"T001","description":"\u8DB3\u591F\u660E\u786E\u7684\u5355\u6B65\u6307\u4EE4","output_format":"text|json|markdown","depend_on":[]}]}',
  "\u89C4\u5219\uFF1A\u4E00\u4E2A\u5B50\u4EFB\u52A1\u53EA\u505A\u4E00\u4EF6\u4E8B\uFF1Bdepend_on \u586B\u4F9D\u8D56\u7684 task_id\uFF1B\u4E0D\u8981\u751F\u6210\u6A21\u7CCA\u6307\u4EE4\u3002",
  "\u6F84\u6E05\uFF1A\u82E5\u7528\u6237\u9700\u6C42\u5728\u5173\u952E\u70B9\u4E0A\u4E0D\u660E\u786E\uFF08\u76EE\u6807\u8DEF\u5F84\u3001\u6587\u4EF6\u540D\u3001\u8F93\u5165/\u8F93\u51FA\u683C\u5F0F\u3001\u9A8C\u6536\u6807\u51C6\u3001\u6280\u672F\u6808\u7B49\uFF09\uFF0C\u5148\u7528 ask_user_question \u5DE5\u5177\u4E00\u6B21\u6027\u63D0\u51FA\u4E0D\u8D85\u8FC7 5 \u4E2A\u6700\u5173\u952E\u7684\u95EE\u9898\uFF08\u6BCF\u4E2A\u5E26\u7A33\u5B9A id\uFF09\uFF0C\u6536\u5230\u7528\u6237\u56DE\u7B54\u540E\u518D\u57FA\u4E8E\u56DE\u7B54\u8F93\u51FA\u6700\u7EC8\u8BA1\u5212 JSON\uFF1B\u82E5\u9700\u6C42\u5DF2\u8DB3\u591F\u660E\u786E\uFF0C\u76F4\u63A5\u8F93\u51FA\u8BA1\u5212\uFF0C\u4E0D\u8981\u4E3A\u4E86\u95EE\u800C\u95EE\u3002"
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
async function planPhase(ctx, config, invocation, task) {
  const run2 = await spawn(ctx, config, invocation, config.plannerModel, plannerPrompt(task), PLANNER_INSTRUCTION, PLAN_SCHEMA);
  const result = await settle(run2);
  if (result.stopReason !== "completed") {
    throw new Error(`planner failed: ${result.stopReason}`);
  }
  const plan = result.structured ?? parseJson(extractText(result.output));
  if (plan === void 0 || !Array.isArray(plan.tasks) || typeof plan.goal !== "string") {
    throw new Error("planner returned no parseable plan");
  }
  return plan;
}
async function executeOne(ctx, config, invocation, task, deps = []) {
  await sleep(jitteredDelay(config.stepIntervalMs));
  const flashAttempts = config.maxRetries + 1;
  let lastFailure = "";
  for (let attempt = 0; attempt <= flashAttempts; attempt += 1) {
    const model = attempt < flashAttempts ? config.executorModel : config.plannerModel;
    try {
      const run2 = await spawn(ctx, config, invocation, model, executorPrompt(task, deps), EXECUTOR_INSTRUCTION);
      const result = await settle(run2);
      if (result.stopReason === "completed") {
        return { task_id: task.task_id, ok: true, text: extractText(result.output), model };
      }
      lastFailure = `stopReason=${result.stopReason}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return { task_id: task.task_id, ok: false, text: lastFailure, model: config.plannerModel };
}
async function executePhase(ctx, config, invocation, plan) {
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
      let index = -1;
      for (let i = 0; i < ordered.length; i += 1) {
        const candidate = ordered[i];
        if (candidate === void 0 || dispatched.has(candidate.task_id)) continue;
        if (isReady(candidate)) {
          index = i;
          break;
        }
      }
      if (index < 0) break;
      const task = ordered[index];
      if (task === void 0) break;
      dispatched.add(task.task_id);
      const deps = (task.depend_on ?? []).map((id) => resultById.get(id)).filter((result2) => result2 !== void 0);
      const result = await executeOne(ctx, config, invocation, task, deps);
      results[index] = result;
      resultById.set(task.task_id, result);
      done.add(task.task_id);
    }
  });
  await Promise.all(workers);
  return results;
}
async function reviewPhase(ctx, config, invocation, plan, results) {
  const run2 = await spawn(ctx, config, invocation, config.reviewerModel, reviewPrompt(plan, results), REVIEW_INSTRUCTION);
  const result = await settle(run2);
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
  const succeeded = results.filter((result) => result.ok).length;
  const lines = [`/pe \u5B8C\u6210 \u2014 \u76EE\u6807\uFF1A${plan.goal}`, `\u5B50\u4EFB\u52A1 ${results.length} \u4E2A\uFF0C\u6210\u529F ${succeeded} \u4E2A`];
  for (const result of results) {
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
async function run(ctx, config, invocation) {
  const task = invocation.rawInput.trim();
  if (task.length === 0) {
    return { kind: "error", text: "Usage: /pe <task description>" };
  }
  try {
    const plan = await planPhase(ctx, config, invocation, task);
    if (config.confirm) {
      const approved = await confirmPlan(ctx, invocation, plan);
      if (!approved) {
        return { kind: "success", text: "\u5DF2\u53D6\u6D88\uFF0C\u672A\u6267\u884C\u4EFB\u4F55\u5B50\u4EFB\u52A1\u3002" };
      }
    }
    let results = await executePhase(ctx, config, invocation, plan);
    let verdict;
    if (config.review) {
      verdict = await reviewPhase(ctx, config, invocation, plan, results);
      if (!verdict.pass && verdict.retryTaskIds.length > 0) {
        const retrySet = new Set(verdict.retryTaskIds);
        const retryTasks = plan.tasks.filter((task2) => retrySet.has(task2.task_id));
        const retried = await executePhase(ctx, config, invocation, { ...plan, tasks: retryTasks });
        for (const item of retried) {
          const at = results.findIndex((existing) => existing.task_id === item.task_id);
          if (at >= 0) results[at] = item;
          else results.push(item);
        }
        verdict = await reviewPhase(ctx, config, invocation, plan, results);
      }
    }
    return { kind: "success", text: renderSummary(plan, results, verdict) };
  } catch (error) {
    return { kind: "error", text: error instanceof Error ? error.message : String(error) };
  }
}
function effortForModel(config, model) {
  if (model === void 0) return void 0;
  if (model === config.executorModel) return config.executorEffort;
  if (model === config.reviewerModel) return config.reviewerEffort;
  if (model === config.plannerModel) return config.plannerEffort;
  return void 0;
}
function apply(ctx, config) {
  ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    if (!childSessions.has(payload.agent.id)) return resolved;
    const effort = effortForModel(config, resolved.model);
    if (effort === void 0) return resolved;
    return { ...resolved, reasoningEffort: effort };
  });
  ctx.commands.register({
    name: "pe",
    description: "Pro plans, Flash executes, Pro reviews \u2014 a rate-limit-friendly Plan-and-Execute pipeline",
    input: { hint: "<task description>" },
    handler: (invocation) => run(ctx, config, invocation)
  });
}
export {
  Config,
  apply,
  inject,
  name
};
