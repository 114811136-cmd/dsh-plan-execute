import z from "@deepseek-ai/schemastery";
//#region lib/types/index.js
/**
* `/pe` (plan-execute) command: Pro plans → Flash executes → Pro reviews.
*
* Built entirely on the subagent seam: every phase is a one-shot in-process
* child (`spawn` provider) whose model is overridden per delegation through
* `agentOptions`. No loop changes, no external process, no manual model switch.
*
* Rate-limit friendliness (`RequestBurstTooFast`) and cost are controlled by
* the same knobs: `maxConcurrency` caps simultaneous Flash children and
* `stepIntervalMs` spaces their starts so request growth is gradual instead of
* bursty. `maxRetries` bounds Flash retries before falling back to the planner
* model, so a flaky step cannot loop forever.
*
* KV-cache friendly by construction: each phase's fixed instruction is mounted
* as the child's `persona` (system position, identical across children), and
* only the dynamic subtask goes in the user `prompt` — so consecutive children
* reuse the same system prefix and hit the provider KV cache instead of paying
* for cold input tokens on every subtask.
*
* @module dsh-plan-execute
*/
const name = "plan-execute";
const inject = [
	"commands",
	"subagents",
	"userQuestions"
];
/** Session ids of children THIS plugin spawned; the thinking override applies only to them. */
const childSessions = /* @__PURE__ */ new Set();
const Config = z.object({
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
	plannerEffort: z.union([
		"off",
		"low",
		"high",
		"max"
	]).default("high"),
	executorEffort: z.union([
		"off",
		"low",
		"high",
		"max"
	]).default("off"),
	reviewerEffort: z.union([
		"off",
		"low",
		"high",
		"max"
	]).default("high"),
	maxDepth: z.number().step(1).min(0).max(8).default(3)
});
/**
* Object-rooted JSON schema for the planner's structured output. Restricted to
* the `assertObjectJsonSchema` subset (type/properties/required/
* additionalProperties/items/enum/const/oneOf). Verify at mount; the text
* fallback below tolerates a provider that rejects the schema.
*/
const PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["goal", "constraints"],
	properties: {
		goal: { type: "string" },
		constraints: {
			type: "array",
			items: { type: "string" }
		},
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
					depend_on: {
						type: "array",
						items: { type: "string" }
					}
				}
			}
		}
	}
};
/** One durable text block for a child's user message. */
function textBlock(text) {
	return {
		type: "text",
		text
	};
}
/** Join the text blocks of a child's final output. */
function extractText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Parse JSON, tolerating a markdown code fence the model may have wrapped it in. */
function parseJson(text) {
	const trimmed = text.trim();
	const candidate = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)?.[1] ?? trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		return;
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Jitter a delay by ±30% so concurrent tasks never start in lockstep. */
function jitteredDelay(ms) {
	if (ms <= 0) return 0;
	const spread = ms * .3;
	return ms + (Math.random() * 2 - 1) * spread;
}
/** Stable Kahn topological sort over `depend_on`; cycles fall back to input order. */
function topoOrder(tasks) {
	const byId = new Map(tasks.map((task) => [task.task_id, task]));
	const indegree = new Map(tasks.map((task) => [task.task_id, 0]));
	const dependents = new Map(tasks.map((task) => [task.task_id, []]));
	for (const task of tasks) for (const dep of task.depend_on ?? []) {
		if (!byId.has(dep)) continue;
		indegree.set(task.task_id, (indegree.get(task.task_id) ?? 0) + 1);
		dependents.get(dep)?.push(task.task_id);
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
/**
* Start one child on `config.provider` with the given model override.
* The fixed instruction rides in the per-child `persona` (system position,
* identical across children → KV-cache reuse); only the dynamic task text goes
* in the user `prompt`.
*/
async function spawn(ctx, config, invocation, model, promptText, personaText, outputSchema) {
	const run = await ctx.subagents.start(config.provider, {
		label: `pe:${model}`,
		persona: personaText,
		prompt: [textBlock(promptText)],
		parent: invocation.agent,
		signal: invocation.signal,
		agentOptions: {
			provider: config.llmProvider,
			model
		},
		maxDepth: config.maxDepth,
		...outputSchema === void 0 ? {} : { outputSchema }
	});
	childSessions.add(run.localAgent?.id ?? run.id);
	return run;
}
/** Await a child's terminal result, always disposing the run afterwards. */
async function settle(run) {
	try {
		return await run.result;
	} finally {
		childSessions.delete(run.localAgent?.id ?? run.id);
		await run.dispose();
	}
}
const PLANNER_INSTRUCTION = [
	"你是任务规划器。把下面的用户需求拆解为可独立执行的子任务，输出严格 JSON，禁止任何额外解释或 markdown 代码块。",
	"结构：{\"goal\":\"整体目标\",\"constraints\":[\"约束\"],\"tasks\":[{\"task_id\":\"T001\",\"description\":\"足够明确的单步指令\",\"output_format\":\"text|json|markdown\",\"depend_on\":[]}]}",
	"规则：一个子任务只做一件事；depend_on 填依赖的 task_id；不要生成模糊指令。",
	"澄清：若用户需求在关键点上不明确（目标路径、文件名、输入/输出格式、验收标准、技术栈等），先用 ask_user_question 工具一次性提出不超过 5 个最关键的问题（每个带稳定 id），收到用户回答后再基于回答输出最终计划 JSON；若需求已足够明确，直接输出计划，不要为了问而问。"
].join("\n");
const EXECUTOR_INSTRUCTION = [
	"你是任务执行者。只完成当前 task_id 对应的这一件事，不要擅自扩展、不要修改目标。",
	"遵守指定的 output_format 输出。若输入信息不足，输出：ERROR:信息不足。",
	"必须真实调用文件/命令工具在沙箱内完成操作（创建/读写文件、运行命令），不能只在回复里描述做法。",
	"若目标文件已存在，先调用 read 工具读取它，再覆盖写入。",
	"若操作被沙箱拒绝（如目标在工作区之外），明确报告被拒原因，不要假装成功。"
].join("\n");
const REVIEW_INSTRUCTION = ["你是结果审核专家。对比原始目标和约束，检查每个子任务的产出。", "只输出 JSON：{\"pass\":true|false,\"retry_task_ids\":[],\"problems\":[]}，不要其他文字。"].join("\n");
function plannerPrompt(task) {
	return `用户需求：${task}`;
}
function executorPrompt(task, deps = []) {
	const lines = [
		`task_id: ${task.task_id}`,
		`任务描述：${task.description}`,
		`要求输出格式：${task.output_format ?? "text"}`
	];
	if (deps.length > 0) {
		lines.push("", "上游任务产出（直接复用，不要重新推导）：");
		for (const dep of deps) lines.push("", `【${dep.task_id}】${dep.ok ? "" : "(该上游任务失败) "}${dep.text}`);
	}
	return lines.join("\n");
}
function reviewPrompt(plan, results) {
	return JSON.stringify({
		goal: plan.goal,
		constraints: plan.constraints,
		results
	}, null, 2);
}
async function planPhase(ctx, config, invocation, task) {
	const result = await settle(await spawn(ctx, config, invocation, config.plannerModel, plannerPrompt(task), PLANNER_INSTRUCTION, PLAN_SCHEMA));
	if (result.stopReason !== "completed") throw new Error(`planner failed: ${result.stopReason}`);
	const plan = result.structured ?? parseJson(extractText(result.output));
	if (plan === void 0 || !Array.isArray(plan.tasks) || typeof plan.goal !== "string") throw new Error("planner returned no parseable plan");
	return plan;
}
async function executeOne(ctx, config, invocation, task, deps = []) {
	await sleep(jitteredDelay(config.stepIntervalMs));
	const flashAttempts = config.maxRetries + 1;
	let lastFailure = "";
	for (let attempt = 0; attempt <= flashAttempts; attempt += 1) {
		const model = attempt < flashAttempts ? config.executorModel : config.plannerModel;
		try {
			const result = await settle(await spawn(ctx, config, invocation, model, executorPrompt(task, deps), EXECUTOR_INSTRUCTION));
			if (result.stopReason === "completed") return {
				task_id: task.task_id,
				ok: true,
				text: extractText(result.output),
				model
			};
			lastFailure = `stopReason=${result.stopReason}`;
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		task_id: task.task_id,
		ok: false,
		text: lastFailure,
		model: config.plannerModel
	};
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
		for (;;) {
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
			const result = await executeOne(ctx, config, invocation, task, (task.depend_on ?? []).map((id) => resultById.get(id)).filter((result) => result !== void 0));
			results[index] = result;
			resultById.set(task.task_id, result);
			done.add(task.task_id);
		}
	});
	await Promise.all(workers);
	return results;
}
async function reviewPhase(ctx, config, invocation, plan, results) {
	const result = await settle(await spawn(ctx, config, invocation, config.reviewerModel, reviewPrompt(plan, results), REVIEW_INSTRUCTION));
	if (result.stopReason !== "completed") return {
		pass: false,
		retryTaskIds: [],
		problems: [`review failed: ${result.stopReason}`]
	};
	const raw = parseJson(extractText(result.output));
	if (raw !== void 0 && typeof raw.pass === "boolean") {
		const retry = raw.retry_task_ids ?? raw.retryTaskIds;
		return {
			pass: raw.pass,
			retryTaskIds: Array.isArray(retry) ? retry.map(String) : [],
			problems: Array.isArray(raw.problems) ? raw.problems.map(String) : []
		};
	}
	return {
		pass: true,
		retryTaskIds: [],
		problems: []
	};
}
function renderSummary(plan, results, verdict) {
	const succeeded = results.filter((result) => result.ok).length;
	const lines = [`/pe 完成 — 目标：${plan.goal}`, `子任务 ${results.length} 个，成功 ${succeeded} 个`];
	for (const result of results) lines.push(`\n【${result.task_id}】${result.ok ? "✓" : "✗"}（${result.model}）\n${result.text}`);
	if (verdict !== void 0) lines.push(`\n复核：${verdict.pass ? "通过" : `未通过 — ${verdict.problems.join("；")}`}`);
	return lines.join("\n");
}
/** Render the plan as a short markdown detail for the approval question. */
function renderPlanDetail(plan) {
	const lines = [`目标：${plan.goal}`];
	if (plan.constraints.length > 0) {
		lines.push("", "约束：");
		for (const constraint of plan.constraints) lines.push(`- ${constraint}`);
	}
	lines.push("", `子任务（共 ${plan.tasks.length} 个）：`);
	for (const task of plan.tasks) {
		const deps = task.depend_on !== void 0 && task.depend_on.length > 0 ? `（依赖：${task.depend_on.join(", ")}）` : "";
		lines.push(`- ${task.task_id}${deps}：${task.description}`);
	}
	return lines.join("\n");
}
/** Ask the user to approve the plan before any executor runs. */
async function confirmPlan(ctx, invocation, plan) {
	return ((await ctx.userQuestions.ask({
		questions: [{
			id: "pe_confirm",
			question: "计划已生成，是否执行？",
			detail: renderPlanDetail(plan),
			options: [{
				label: "执行",
				description: "按计划并行执行子任务（Pro 规划 → Flash 执行 → Pro 复核）"
			}, {
				label: "取消",
				description: "不执行任何子任务，结束本次 /pe"
			}],
			intent: {
				kind: "plan-review",
				approve: "执行"
			}
		}],
		agent: invocation.agent,
		signal: invocation.signal
	})).answers.find((item) => item.id === "pe_confirm")?.selected ?? []).includes("执行");
}
async function run(ctx, config, invocation) {
	const task = invocation.rawInput.trim();
	if (task.length === 0) return {
		kind: "error",
		text: "Usage: /pe <task description>"
	};
	try {
		const plan = await planPhase(ctx, config, invocation, task);
		if (config.confirm) {
			if (!await confirmPlan(ctx, invocation, plan)) return {
				kind: "success",
				text: "已取消，未执行任何子任务。"
			};
		}
		let results = await executePhase(ctx, config, invocation, plan);
		let verdict;
		if (config.review) {
			verdict = await reviewPhase(ctx, config, invocation, plan, results);
			if (!verdict.pass && verdict.retryTaskIds.length > 0) {
				const retrySet = new Set(verdict.retryTaskIds);
				const retryTasks = plan.tasks.filter((task) => retrySet.has(task.task_id));
				const retried = await executePhase(ctx, config, invocation, {
					...plan,
					tasks: retryTasks
				});
				for (const item of retried) {
					const at = results.findIndex((existing) => existing.task_id === item.task_id);
					if (at >= 0) results[at] = item;
					else results.push(item);
				}
				verdict = await reviewPhase(ctx, config, invocation, plan, results);
			}
		}
		return {
			kind: "success",
			text: renderSummary(plan, results, verdict)
		};
	} catch (error) {
		return {
			kind: "error",
			text: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Map one resolved model to its configured thinking effort, or leave it alone. */
function effortForModel(config, model) {
	if (model === void 0) return void 0;
	if (model === config.executorModel) return config.executorEffort;
	if (model === config.reviewerModel) return config.reviewerEffort;
	if (model === config.plannerModel) return config.plannerEffort;
}
function apply(ctx, config) {
	ctx.on("agent/request", async (payload, next) => {
		const resolved = await next();
		if (!childSessions.has(payload.agent.id)) return resolved;
		const effort = effortForModel(config, resolved.model);
		if (effort === void 0) return resolved;
		return {
			...resolved,
			reasoningEffort: effort
		};
	});
	ctx.commands.register({
		name: "pe",
		description: "Pro plans, Flash executes, Pro reviews — a rate-limit-friendly Plan-and-Execute pipeline",
		input: { hint: "<task description>" },
		handler: (invocation) => run(ctx, config, invocation)
	});
}
//#endregion
export { Config, apply, inject, name };
