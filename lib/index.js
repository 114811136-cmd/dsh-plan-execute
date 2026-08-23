// src/index.ts
import z from "@deepseek-ai/schemastery";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  clarifyEffort: z.union(["off", "low", "high", "max"]).default("low"),
  executorEffort: z.union(["off", "low", "high", "max"]).default("off"),
  reviewerEffort: z.union(["off", "low", "high", "max"]).default("low"),
  maxDepth: z.number().step(1).min(0).max(8).default(3),
  executorTimeoutMs: z.number().step(1).min(1e4).max(6e5).default(12e4),
  maxFixRounds: z.number().step(1).min(0).max(5).default(2),
  clarifyTimeoutMs: z.number().step(1).min(6e4).max(9e5).default(3e5)
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
          depend_on: { type: "array", items: { type: "string" } },
          files: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};
var STATE_FILENAME = ".pe-plan.json";
function statePath(cwd) {
  return join(cwd, STATE_FILENAME);
}
async function readState(cwd) {
  try {
    const raw = await readFile(statePath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.modules)) {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
async function writeState(cwd, state) {
  try {
    await writeFile(statePath(cwd), JSON.stringify(state, null, 2), "utf8");
  } catch {
  }
}
function mergeState(old, plan) {
  const modules = (old?.modules ?? []).map((module) => ({ ...module }));
  for (const task of plan.tasks) {
    const files = task.files ?? [];
    const idx = modules.findIndex((module) => module.files.some((file) => files.includes(file)));
    if (idx >= 0) {
      modules[idx] = { task_id: task.task_id, description: task.description, files };
    } else {
      modules.push({ task_id: task.task_id, description: task.description, files });
    }
  }
  return { goal: plan.goal, modules };
}
function renderStatePrompt(state) {
  const lines = [`\u73B0\u6709\u9879\u76EE\uFF1A${state.goal}`, "\u5DF2\u5B8C\u6210\u6A21\u5757\uFF1A"];
  for (const module of state.modules) {
    const files = module.files.length > 0 ? ` \u2192 ${module.files.join(", ")}` : "";
    lines.push(`- ${module.task_id} ${module.description}${files}`);
  }
  return lines.join("\n");
}
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
async function spawn(ctx, config, invocation, model, effort, childEfforts, promptText, personaText, outputSchema, labelSuffix) {
  const run2 = await ctx.subagents.start(config.provider, {
    label: `pe:${model}${labelSuffix === void 0 ? "" : `\xB7${labelSuffix}`}`,
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
var CLARIFY_INSTRUCTION = [
  "\u4F60\u5904\u4E8E\u300C\u9700\u6C42\u5BA1\u95EE\u6A21\u5F0F\u300D\u3002\u7528\u6237\u7684\u8BF7\u6C42\u53EA\u662F\u8D77\u70B9\uFF0C\u4F60\u7684\u552F\u4E00\u804C\u8D23\u662F\u628A\u771F\u5B9E\u9700\u6C42\u95EE\u6E05\u695A\u3002",
  "\u94C1\u5F8B\uFF1A\u7981\u6B62\u76F4\u63A5\u7ED9\u51FA\u6700\u7EC8\u7B54\u6848\u6216\u65B9\u6848\u3002\u5728\u9700\u6C42\u6CA1\u6709\u95EE\u6E05\u695A\u4E4B\u524D\uFF0C\u7981\u6B62\u8F93\u51FA\u4EFB\u4F55\u65B9\u6848\u3001\u8BA1\u5212\u6216\u7ED3\u8BBA\u3002",
  "\u8FFD\u95EE\u89C4\u5219\uFF1A",
  "1. \u4E00\u6B21\u53EA\u95EE 1 \u4E2A\u6700\u5173\u952E\u7684\u95EE\u9898\uFF1A\u4F7F\u7528 ask_user_question \u5DE5\u5177\uFF0C\u6BCF\u8F6E\u53EA\u63D0 1 \u4E2A\u95EE\u9898\uFF08\u5E26\u7A33\u5B9A id\uFF09\uFF0C\u7EDD\u4E0D\u8981\u4E00\u6B21\u629B\u591A\u4E2A\u95EE\u9898\u3002",
  "2. \u57FA\u4E8E\u56DE\u7B54\u7EE7\u7EED\u8FFD\u95EE\uFF1A\u6BCF\u4E00\u8F6E\u95EE\u9898\u5FC5\u987B\u7D27\u63A5\u7528\u6237\u4E0A\u4E00\u8F6E\u7684\u7B54\u6848\u6DF1\u5165\uFF0C\u5F62\u6210\u8FFD\u95EE\u94FE\uFF0C\u800C\u4E0D\u662F\u5E73\u884C\u7F57\u5217\u95EE\u9898\u3002",
  '3. \u6BCF\u8F6E\u95EE\u9898\u5FC5\u987B\u5C16\u9510\u3001\u5177\u4F53\u3001\u5FC5\u8981\uFF1A\u4E0D\u80FD\u6CDB\u6CDB\u800C\u95EE\uFF08\u5982"\u8FD8\u6709\u5417""\u80FD\u518D\u8BF4\u8BF4\u5417"\uFF09\uFF0C\u4E0D\u80FD\u91CD\u590D\u5DF2\u95EE\u8FC7\u7684\u95EE\u9898\uFF0C\u53EA\u95EE\u771F\u6B63\u5F71\u54CD\u65B9\u6848\u8D70\u5411\u7684\u5173\u952E\u70B9\u3002',
  "4. \u8981\u95EE\u6E05\u695A\u7684\u5168\u90E8\u7EF4\u5EA6\uFF1A\u771F\u5B9E\u9700\u6C42\uFF08\u5230\u5E95\u8981\u89E3\u51B3\u4EC0\u4E48\u95EE\u9898\u3001\u6838\u5FC3\u75DB\u70B9\u662F\u4EC0\u4E48\uFF09\u3001\u4F7F\u7528\u573A\u666F\uFF08\u5728\u4EC0\u4E48\u60C5\u51B5\u4E0B\u7528\u3001\u8C01\u5728\u7528\uFF09\u3001\u76EE\u6807\u7ED3\u679C\uFF08\u505A\u5230\u4EC0\u4E48\u7A0B\u5EA6\u7B97\u6210\u529F\uFF09\u3001\u9650\u5236\u6761\u4EF6\uFF08\u65F6\u95F4/\u9884\u7B97/\u6280\u672F/\u73AF\u5883/\u5408\u89C4\u7EA6\u675F\uFF09\u3001\u5224\u65AD\u6807\u51C6\uFF08\u600E\u4E48\u9A8C\u6536\u624D\u7B97\u901A\u8FC7\uFF09\u3001\u9690\u85CF\u504F\u597D\uFF08\u7528\u6237\u6CA1\u660E\u8BF4\u4F46\u5F71\u54CD\u9009\u62E9\u7684\u503E\u5411\uFF09\u3002",
  "5. \u514B\u5236\u63D0\u95EE\uFF1A\u6BCF\u8F6E\u53EA\u95EE\u5F53\u524D\u6700\u5F71\u54CD\u65B9\u6848\u7684\u90A3\u4E00\u4E2A\u95EE\u9898\uFF0C\u4E0D\u8981\u4E3A\u95EE\u800C\u95EE\u3002",
  "\u505C\u6B62\u6761\u4EF6\uFF1A\u5F53\u4F60\u8BA4\u4E3A\u5DF2\u7ECF\u57FA\u672C\u7406\u89E3\u7528\u6237\u7684\u771F\u5B9E\u9700\u6C42\uFF0C\u5E76\u80FD\u636E\u6B64\u7ED9\u51FA\u53EF\u6267\u884C\u65B9\u6848\u65F6\uFF0C\u7ACB\u5373\u505C\u6B62\u8FFD\u95EE\uFF0C\u4E0D\u8981\u518D\u95EE\u3002",
  "\u505C\u6B62\u8FFD\u95EE\u540E\uFF0C\u8F93\u51FA\u4E24\u6BB5\u5185\u5BB9\uFF0C\u7528\u6807\u9898\u4E25\u683C\u9694\u5F00\uFF1A",
  "\u7B2C\u4E00\u6BB5\u6807\u9898\u4E3A\u300C\u3010\u9700\u6C42\u6458\u8981\u3011\u300D\uFF1A\u53EA\u5199\u5185\u90E8\u89C4\u5212\u6240\u9700\u7684\u7CBE\u7B80\u4FE1\u606F\u2014\u2014\u771F\u5B9E\u9700\u6C42\u3001\u7EA6\u675F\u6761\u4EF6\u3001\u9A8C\u6536\u6807\u51C6\u3001\u5173\u952E\u63D0\u9192\u5404\u4E00\u53E5\u8BDD\u3002\u4E0D\u8981\u5199\u65B9\u6848\u3001\u7406\u7531\u6216\u6267\u884C\u6B65\u9AA4\uFF08\u8FD9\u4E9B\u7531\u540E\u7EED\u89C4\u5212\u9636\u6BB5\u751F\u6210\uFF09\u3002",
  "\u7B2C\u4E8C\u6BB5\u6807\u9898\u4E3A\u300C\u3010\u5B8C\u6574\u7B54\u6848\u3011\u300D\uFF1A\u7ED9\u7528\u6237\u770B\u7684\u5B8C\u6574\u7B54\u6848\uFF0C\u5FC5\u987B\u5305\u542B\u4E94\u90E8\u5206\u2014\u2014\u771F\u5B9E\u9700\u6C42\u3001\u6700\u9002\u5408\u7684\u65B9\u6848\u3001\u4E3A\u4EC0\u4E48\u8FD9\u6837\u505A\u3001\u5177\u4F53\u6267\u884C\u6B65\u9AA4\u3001\u6700\u5BB9\u6613\u5FFD\u7565\u7684\u5173\u952E\u63D0\u9192\u3002",
  "\u8F93\u51FA\u4E3A\u7EAF\u6587\u672C\uFF0C\u4E0D\u8981\u8F93\u51FA JSON\uFF0C\u4E0D\u8981\u8F93\u51FA\u591A\u4F59\u683C\u5F0F\u3002"
].join("\n");
var PLANNER_INSTRUCTION = [
  "\u4F60\u662F\u4EFB\u52A1\u89C4\u5212\u5668\u3002\u628A\u4E0B\u9762\u7684\u7528\u6237\u9700\u6C42\u62C6\u89E3\u4E3A\u53EF\u72EC\u7ACB\u6267\u884C\u7684\u5B50\u4EFB\u52A1\uFF0C\u8F93\u51FA\u4E25\u683C JSON\uFF0C\u7981\u6B62\u4EFB\u4F55\u989D\u5916\u89E3\u91CA\u6216 markdown \u4EE3\u7801\u5757\u3002",
  '\u7ED3\u6784\uFF1A{"goal":"\u6574\u4F53\u76EE\u6807","constraints":["\u7EA6\u675F"],"tasks":[{"task_id":"T001","description":"\u8DB3\u591F\u660E\u786E\u7684\u5355\u6B65\u6307\u4EE4","output_format":"text|json|markdown","depend_on":[],"files":["\u6D89\u53CA\u7684\u6587\u4EF6\u8DEF\u5F84"]}]}',
  "\u89C4\u5219\uFF1A\u4E00\u4E2A\u5B50\u4EFB\u52A1\u53EA\u505A\u4E00\u4EF6\u4E8B\uFF1Bdepend_on \u586B\u4F9D\u8D56\u7684 task_id\uFF1B\u4E0D\u8981\u751F\u6210\u6A21\u7CCA\u6307\u4EE4\u3002",
  "\u6BCF\u4E2A\u5B50\u4EFB\u52A1\u5FC5\u987B\u7528 files \u5B57\u6BB5\u58F0\u660E\u5B83\u5C06\u8981\u521B\u5EFA\u6216\u4FEE\u6539\u7684\u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u533A\uFF09\uFF0C\u8FD9\u662F\u540E\u7EED\u589E\u91CF\u8FED\u4EE3\u7684\u5173\u952E\u4F9D\u636E\uFF0C\u4E0D\u80FD\u7701\u7565\u3002",
  "\u82E5\u9700\u6C42\u91CC\u7ED9\u51FA\u4E86\u300C\u73B0\u6709\u9879\u76EE\u73B0\u72B6\u300D\uFF08\u5DF2\u6709\u6A21\u5757\u53CA\u6587\u4EF6\u6E05\u5355\uFF09\uFF0C\u4F60\u5FC5\u987B\u53EA\u62C6\u672C\u6B21\u9700\u6C42\u76F8\u5173\u7684\u65B0\u4EFB\u52A1\u6216\u4FEE\u6539\u4EFB\u52A1\uFF1B\u5DF2\u5B8C\u6210\u7684\u6A21\u5757\u4E0D\u8981\u91CD\u590D\u62C6\u89E3\uFF0C\u53EA\u5728\u5176\u9700\u8981\u88AB\u4FEE\u6539\u65F6\u624D\u5217\u5165\uFF0C\u5E76\u5728 files \u91CC\u6307\u5411\u5BF9\u5E94\u6587\u4EF6\u3002",
  "\u6CE8\u610F\uFF1A\u7528\u6237\u9700\u6C42\u5DF2\u7ECF\u8FC7\u6F84\u6E05\u786E\u8BA4\uFF0C\u76F4\u63A5\u62C6\u89E3\u5373\u53EF\uFF0C\u4E0D\u8981\u5411\u7528\u6237\u63D0\u95EE\uFF1B\u82E5\u4ECD\u6709\u65E0\u6CD5\u786E\u5B9A\u7684\u5173\u952E\u70B9\uFF0C\u628A\u5B83\u5199\u8FDB constraints \u4F5C\u4E3A\u5047\u8BBE\u6761\u4EF6\uFF0C\u5E76\u5728\u4EFB\u52A1\u4E2D\u505A\u51FA\u5408\u7406\u9ED8\u8BA4\u3002"
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
  const taskStart = Date.now();
  for (let attempt = 0; attempt <= flashAttempts; attempt += 1) {
    if (invocation.signal.aborted) {
      return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model: "\u2014", elapsedMs: Date.now() - taskStart };
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
        EXECUTOR_INSTRUCTION,
        void 0,
        task.task_id
      );
      const result = await settleWithTimeout(run2, childEfforts, config.executorTimeoutMs);
      if (result.stopReason === "completed") {
        return { task_id: task.task_id, ok: true, text: extractText(result.output), model, elapsedMs: Date.now() - taskStart };
      }
      if (invocation.signal.aborted) {
        return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model, elapsedMs: Date.now() - taskStart };
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
        return { task_id: task.task_id, ok: false, text: "\u5DF2\u505C\u6B62", model, elapsedMs: Date.now() - taskStart };
      }
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return { task_id: task.task_id, ok: false, text: lastFailure, model: config.plannerModel, elapsedMs: Date.now() - taskStart };
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
  const totalMs = results.reduce((sum, r) => sum + (r?.elapsedMs ?? 0), 0);
  const lines = [
    `/pe \u5B8C\u6210 \u2014 \u76EE\u6807\uFF1A${plan.goal}`,
    `\u5B50\u4EFB\u52A1 ${results.length} \u4E2A\uFF0C\u6210\u529F ${succeeded} \u4E2A\uFF0C\u603B\u8017\u65F6 ${(totalMs / 1e3).toFixed(1)}s`
  ];
  for (const result of results) {
    if (result === void 0) continue;
    const elapsed = result.elapsedMs !== void 0 ? `\uFF08${(result.elapsedMs / 1e3).toFixed(1)}s\uFF09` : "";
    lines.push(`
\u3010${result.task_id}\u3011${result.ok ? "\u2713" : "\u2717"}${elapsed}\uFF08${result.model}\uFF09
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
async function confirmPlan(ctx, invocation, plan, fullAnswer) {
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: "pe_confirm",
      question: "\u8BA1\u5212\u5DF2\u751F\u6210\uFF0C\u662F\u5426\u6267\u884C\uFF1F",
      detail: `\u9700\u6C42\u6F84\u6E05\u7ED3\u8BBA\uFF1A
${fullAnswer}

\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
${renderPlanDetail(plan)}`,
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
var FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "reason", "revised_description"],
        properties: {
          task_id: { type: "string" },
          reason: { type: "string" },
          revised_description: { type: "string" }
        }
      }
    }
  }
};
var FIX_INSTRUCTION = [
  "\u4F60\u662F\u4EFB\u52A1\u8BCA\u65AD\u4E13\u5BB6\u3002\u7528\u6237\u5BF9\u5DF2\u5B8C\u6210\u7684\u7ED3\u679C\u63D0\u51FA\u4E0D\u6EE1\u6216\u6539\u8FDB\u8981\u6C42\uFF0C\u4F60\u53EA\u8D1F\u8D23\u5224\u65AD\uFF1A\u54EA\u4E2A\u5B50\u4EFB\u52A1\u9700\u8981\u91CD\u65B0\u6267\u884C\u3001\u5E94\u8BE5\u6539\u9020\u6210\u4EC0\u4E48\u6837\u3002\u4E0D\u8981\u771F\u7684\u6267\u884C\uFF0C\u53EA\u8F93\u51FA\u8BCA\u65AD\u65B9\u6848\u3002",
  "\u7528\u6237\u4F1A\u7ED9\u51FA\uFF1A\u539F\u59CB\u76EE\u6807\u3001\u5404\u5B50\u4EFB\u52A1\u7684\u4EA7\u51FA\u3001\u4EE5\u53CA\u4ED6\u7684\u95EE\u9898/\u8981\u6C42\u3002",
  "\u89C4\u5219\uFF1A\u53EA\u6539\u52A8\u771F\u6B63\u53D7\u7528\u6237\u95EE\u9898\u5F71\u54CD\u7684\u5B50\u4EFB\u52A1\uFF0C\u672A\u88AB\u5F71\u54CD\u7684\u5B50\u4EFB\u52A1\u4E0D\u8981\u5217\u5165\uFF1Brest_reason \u7528\u4E00\u53E5\u8BDD\u8BF4\u660E\u4E3A\u4EC0\u4E48\u6539\u5B83\uFF1Brevised_description \u5199\u6E05\u695A\u4FEE\u6539\u540E\u8BE5\u5B50\u4EFB\u52A1\u8981\u91CD\u65B0\u505A\u4EC0\u4E48\uFF08\u8DB3\u591F\u660E\u786E\uFF0C\u4F9B\u6267\u884C\u8005\u7167\u505A\uFF09\u3002",
  "\u82E5\u7528\u6237\u7684\u95EE\u9898\u4E0D\u9488\u5BF9\u4EFB\u4F55\u73B0\u6709\u5B50\u4EFB\u52A1\uFF0C\u6216\u4FE1\u606F\u4E0D\u8DB3\u65E0\u6CD5\u5B9A\u4F4D\uFF0C\u8F93\u51FA\u7A7A\u6570\u7EC4 tasks\u3002"
].join("\n");
async function askSatisfaction(ctx, invocation, plan, results) {
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const resultLines = results.filter((result) => result !== void 0).map((result) => {
    const desc = byId.get(result.task_id)?.description ?? "";
    return `- ${result.task_id} ${result.ok ? "\u2713" : "\u2717"}\uFF1A${desc}`;
  });
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: "pe_satis",
      question: "\u5168\u90E8\u5B8C\u6210\u3002\u6EE1\u610F\u5417\uFF1F\u5982\u6709\u8981\u8C03\u6574\u7684\u5730\u65B9\uFF0C\u8BF7\u76F4\u63A5\u5728\u4E0B\u6846\u63CF\u8FF0\u4F60\u7684\u95EE\u9898/\u8981\u6C42\u3002",
      detail: `\u7ED3\u679C\uFF1A
${resultLines.join("\n")}

\u6EE1\u610F\u8BF7\u9009\u300C\u7ED3\u675F\u300D\uFF1B\u8981\u6539\u5C31\u76F4\u63A5\u63CF\u8FF0\u95EE\u9898\uFF08\u4F8B\u5982\uFF1A\u62A5\u8868\u683C\u5F0F\u4E0D\u5BF9\uFF0C\u6211\u9700\u8981\u67F1\u72B6\u56FE\uFF1BT003 \u7684\u6570\u636E\u6709\u8BEF\uFF09\u3002`,
      options: [
        { label: "\u7ED3\u675F\uFF08\u6EE1\u610F\uFF09", description: "\u4FDD\u7559\u5F53\u524D\u7ED3\u679C\uFF0C\u7ED3\u675F" }
      ]
    }],
    agent: invocation.agent,
    signal: invocation.signal
  });
  const item = answer.answers.find((entry) => entry.id === "pe_satis");
  const selected = item?.selected ?? [];
  const custom = item?.custom?.trim() ?? "";
  if (selected.includes("\u7ED3\u675F\uFF08\u6EE1\u610F\uFF09")) {
    return { satisfied: true, problem: "" };
  }
  if (custom.length > 0) {
    return { satisfied: false, problem: custom };
  }
  return { satisfied: true, problem: "" };
}
async function diagnoseFix(ctx, config, invocation, plan, results, problem, childEfforts) {
  const byId = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const resultLines = results.filter((result2) => result2 !== void 0).map((result2) => {
    const desc = byId.get(result2.task_id)?.description ?? "";
    const outcome = result2.ok ? "\u6210\u529F" : "\u5931\u8D25";
    const snippet = result2.text.length > 160 ? `${result2.text.slice(0, 160)}\u2026` : result2.text;
    return `\u3010${result2.task_id}\u3011${desc}
\u72B6\u6001\uFF1A${outcome}
\u4EA7\u51FA\uFF1A${snippet}`;
  });
  const prompt = [
    `\u539F\u59CB\u76EE\u6807\uFF1A${plan.goal}`,
    `\u7528\u6237\u95EE\u9898/\u8981\u6C42\uFF1A${problem}`,
    "",
    "\u5404\u5B50\u4EFB\u52A1\u4EA7\u51FA\uFF1A",
    resultLines.join("\n")
  ].join("\n");
  const run2 = await spawn(
    ctx,
    config,
    invocation,
    config.plannerModel,
    config.clarifyEffort,
    childEfforts,
    prompt,
    FIX_INSTRUCTION,
    FIX_SCHEMA,
    "fix-diagnose"
  );
  const result = await settle(run2, childEfforts);
  if (result.stopReason !== "completed") {
    return { tasks: [] };
  }
  const raw = result.structured ?? parseJson(extractText(result.output));
  if (raw === void 0 || !Array.isArray(raw.tasks)) {
    return { tasks: [] };
  }
  const knownIds = new Set(plan.tasks.map((task) => task.task_id));
  const tasks = raw.tasks.filter((item) => item !== void 0 && knownIds.has(item.task_id) && typeof item.revised_description === "string" && item.revised_description.length > 0).map((item) => ({
    task_id: item.task_id,
    reason: typeof item.reason === "string" ? item.reason : "",
    revised_description: item.revised_description
  }));
  return { tasks };
}
async function confirmFix(ctx, invocation, fix) {
  const lines = fix.tasks.map((item2) => {
    const reason = item2.reason.length > 0 ? `
  \u539F\u56E0\uFF1A${item2.reason}` : "";
    return `- ${item2.task_id}${reason}
  \u4FEE\u6539\u540E\uFF1A${item2.revised_description}`;
  });
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: "pe_fixconfirm",
      question: "\u8BCA\u65AD\u5230\u4EE5\u4E0B\u4FEE\u6539\u65B9\u6848\uFF0C\u662F\u5426\u6267\u884C\uFF1F",
      detail: `\u5EFA\u8BAE\u4FEE\u6539 ${fix.tasks.length} \u4E2A\u5B50\u4EFB\u52A1\uFF08\u5176\u4F59\u4FDD\u7559\uFF09\uFF1A
${lines.join("\n")}`,
      options: [
        { label: "\u786E\u8BA4\u6267\u884C", description: "\u53EA\u91CD\u8DD1\u4E0A\u8FF0\u5B50\u4EFB\u52A1\uFF0C\u5176\u4ED6\u7ED3\u679C\u4FDD\u7559" },
        { label: "\u653E\u5F03\u4FEE\u6539", description: "\u4E0D\u91CD\u8DD1\uFF0C\u4FDD\u7559\u5F53\u524D\u7ED3\u679C\u7ED3\u675F" }
      ]
    }],
    agent: invocation.agent,
    signal: invocation.signal
  });
  const item = answer.answers.find((entry) => entry.id === "pe_fixconfirm");
  const selected = item?.selected ?? [];
  return selected.includes("\u786E\u8BA4\u6267\u884C");
}
async function clarifyPhase(ctx, config, invocation, task, childEfforts) {
  const run2 = await spawn(
    ctx,
    config,
    invocation,
    config.plannerModel,
    config.clarifyEffort,
    childEfforts,
    plannerPrompt(task),
    CLARIFY_INSTRUCTION,
    void 0,
    "clarify"
  );
  const result = await settleWithTimeout(run2, childEfforts, config.clarifyTimeoutMs);
  if (invocation.signal.aborted) {
    throw new Error("\u5DF2\u505C\u6B62");
  }
  if (result.stopReason !== "completed" || result.timedOut) {
    const why = result.timedOut ? `\u76EE\u6807\u6F84\u6E05\u8D85\u65F6\uFF08${Math.round(config.clarifyTimeoutMs / 1e3)}s\uFF09` : `stopReason=${result.stopReason}`;
    throw new Error(`\u76EE\u6807\u6F84\u6E05\u5931\u8D25\uFF1A${why}\u3002\u8BF7\u91CD\u65B0\u53D1\u9001 /pe \u5E76\u7ED9\u51FA\u66F4\u6E05\u6670\u7684\u76EE\u6807\u3002`);
  }
  const clarified = extractText(result.output).trim();
  if (clarified.length === 0) {
    throw new Error("\u76EE\u6807\u6F84\u6E05\u65E0\u7ED3\u679C\uFF1A\u8BF7\u91CD\u65B0\u53D1\u9001 /pe\u3002");
  }
  const summaryMatch = /【需求摘要】\s*([\s\S]*?)(?=【完整答案】|$)/iu.exec(clarified);
  const fullMatch = /【完整答案】\s*([\s\S]*)/iu.exec(clarified);
  const summary = (summaryMatch?.[1] ?? clarified).trim();
  const fullAnswer = (fullMatch?.[1] ?? clarified).trim();
  return { summary: summary.length > 0 ? summary : clarified, fullAnswer };
}
async function run(ctx, config, invocation, childEfforts) {
  const task = invocation.rawInput.trim();
  if (task.length === 0) {
    return { kind: "error", text: "Usage: /pe <task description>" };
  }
  const signal = invocation.signal;
  try {
    const clarification = await clarifyPhase(ctx, config, invocation, task, childEfforts);
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    const cwd = invocation.agent.session.header.cwd;
    const priorState = cwd === void 0 ? void 0 : await readState(cwd);
    const planInput = priorState === void 0 ? clarification.summary : `\u3010\u73B0\u6709\u9879\u76EE\u73B0\u72B6\u3011
${renderStatePrompt(priorState)}

\u3010\u672C\u6B21\u9700\u6C42\u3011
${clarification.summary}`;
    const plan = await planPhase(ctx, config, invocation, planInput, childEfforts);
    if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
    if (config.confirm) {
      const approved = await confirmPlan(ctx, invocation, plan, clarification.fullAnswer);
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
    }
    for (let round = 0; round < config.maxFixRounds; round += 1) {
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      const satis = await askSatisfaction(ctx, invocation, plan, results);
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      if (satis.satisfied) break;
      const fix = await diagnoseFix(ctx, config, invocation, plan, results, satis.problem, childEfforts);
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      if (fix.tasks.length === 0) {
        return { kind: "success", text: `\u672A\u5B9A\u4F4D\u5230\u9700\u4FEE\u6539\u7684\u5B50\u4EFB\u52A1\uFF1A${satis.problem}

${renderSummary(plan, results, verdict)}` };
      }
      const confirmed = await confirmFix(ctx, invocation, fix);
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      if (!confirmed) break;
      const fixById = new Map(fix.tasks.map((item) => [item.task_id, item]));
      const retryTasks = plan.tasks.filter((task2) => fixById.has(task2.task_id)).map((task2) => ({
        ...task2,
        description: fixById.get(task2.task_id)?.revised_description ?? task2.description
      }));
      if (retryTasks.length === 0) break;
      const retried = await executePhase(ctx, config, invocation, { ...plan, tasks: retryTasks }, childEfforts);
      if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      for (const item of retried) {
        const at = results.findIndex((existing) => existing.task_id === item.task_id);
        if (at >= 0) results[at] = item;
        else results.push(item);
      }
      if (config.review) {
        verdict = await reviewPhase(ctx, config, invocation, plan, results, childEfforts);
        if (signal.aborted) return { kind: "error", text: "\u5DF2\u505C\u6B62" };
      }
    }
    if (cwd !== void 0) {
      await writeState(cwd, mergeState(priorState, plan));
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
