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
 * Cancellation: every phase, worker scan, and retry loop checks the invocation
 * `AbortSignal`, so pressing "停止生成" in the UI tears the whole pipeline down
 * promptly instead of draining every queued task against an aborted signal.
 *
 * Thinking-effort injection is scoped per-plugin-instance and per-child (a
 * `Map` keyed by child session id, populated at spawn and cleared at settle),
 * so a running `/pe` can no longer rewrite the reasoning effort of ordinary
 * concurrent chat, and a planner/reviewer sharing the same model still gets
 * each phase's own effort level.
 *
 * @module dsh-plan-execute
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'plan-execute'
export const inject = ['commands', 'subagents', 'userQuestions']

/** DeepSeek thinking effort levels accepted by the adapter. */
type Effort = 'off' | 'low' | 'high' | 'max'

/** Per-plugin-instance map from child session id to its thinking effort. */
type ChildEfforts = Map<string, Effort>

/**
 * Deployment-varying choices. Every tunable here is a validated `Config` field
 * changeable from `cordis.yml` — never hardcoded at the call site.
 */
export interface Config {
  /** `ctx.subagents` provider name. In-process `spawn` ships in every profile. */
  provider: string
  /** Provider route used for every child (matches `agent-default-model`). */
  llmProvider: string
  /** Planner model (global decomposition, structured JSON output). */
  plannerModel: string
  /** Executor model (bulk, cheap, thinking-off single steps). */
  executorModel: string
  /** Reviewer model (final verification against the original goal). */
  reviewerModel: string
  /** Max simultaneous executor children — the primary `RequestBurstTooFast` guard. */
  maxConcurrency: number
  /** Minimum delay between executor starts, jittered ±30% (gradual traffic growth). */
  stepIntervalMs: number
  /** Flash retries per subtask before falling back to `plannerModel`. */
  maxRetries: number
  /** Run the reviewer phase after all subtasks. */
  review: boolean
  /** Ask the user to approve the plan before executing. */
  confirm: boolean
  /** Thinking effort for the planner child. */
  plannerEffort: Effort
  /** Thinking effort for the clarify child (`low` is enough for asking questions). */
  clarifyEffort: Effort
  /** Thinking effort for executor children (`off` saves the most tokens). */
  executorEffort: Effort
  /** Thinking effort for the reviewer child (`low` is enough for pass/fail). */
  reviewerEffort: Effort
  /** Delegation-depth cap passed to every child. */
  maxDepth: number
  /** Hard per-attempt timeout for one executor child (ms). A stuck child is
   *  aborted after this and retried, never waited on forever. */
  executorTimeoutMs: number
  /** Max interactive fix rounds when subtasks fail or review rejects. */
  maxFixRounds: number
  /** Hard timeout for the LLM-driven goal-clarification phase (ms). */
  clarifyTimeoutMs: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  llmProvider: z.string().default('deepseek-official'),
  plannerModel: z.string().default('deepseek-v4-pro'),
  executorModel: z.string().default('deepseek-v4-flash'),
  reviewerModel: z.string().default('deepseek-v4-pro'),
  maxConcurrency: z.number().step(1).min(1).max(16).default(2),
  stepIntervalMs: z.number().step(1).min(0).default(800),
  maxRetries: z.number().step(1).min(0).max(5).default(2),
  review: z.boolean().default(true),
  confirm: z.boolean().default(true),
  plannerEffort: z.union(['off', 'low', 'high', 'max'] as const).default('high'),
  clarifyEffort: z.union(['off', 'low', 'high', 'max'] as const).default('low'),
  executorEffort: z.union(['off', 'low', 'high', 'max'] as const).default('off'),
  reviewerEffort: z.union(['off', 'low', 'high', 'max'] as const).default('low'),
  maxDepth: z.number().step(1).min(0).max(8).default(3),
  executorTimeoutMs: z.number().step(1).min(10000).max(600000).default(120000),
  maxFixRounds: z.number().step(1).min(0).max(5).default(2),
  clarifyTimeoutMs: z.number().step(1).min(60000).max(900000).default(300000),
})

/**
 * Object-rooted JSON schema for the planner's structured output. Restricted to
 * the `assertObjectJsonSchema` subset (type/properties/required/
 * additionalProperties/items/enum/const/oneOf). Verify at mount; the text
 * fallback below tolerates a provider that rejects the schema.
 */
const PLAN_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'constraints'],
  properties: {
    goal: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id', 'description'],
        properties: {
          task_id: { type: 'string' },
          description: { type: 'string' },
          output_format: { type: 'string' },
          depend_on: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

interface PlanTask {
  task_id: string
  description: string
  output_format?: string
  depend_on?: string[]
  /** Files this task will create or modify (declared by the planner). */
  files?: string[]
}

interface Plan {
  goal: string
  constraints: string[]
  tasks: PlanTask[]
}

interface TaskResult {
  task_id: string
  ok: boolean
  text: string
  model: string
  /** Wall-clock duration of the task's whole attempt series, ms. */
  elapsedMs?: number
}

interface ReviewVerdict {
  pass: boolean
  retryTaskIds: string[]
  problems: string[]
}

/**
 * Persisted project state for cross-/pe incremental iteration. Records the
 * goal and the module list (task ↔ files), so a later /pe can plan only the
 * affected modules instead of redoing everything.
 */
interface ProjectState {
  goal: string
  modules: Array<{ task_id: string; description: string; files: string[] }>
}

/** Archive filename inside the workspace root. */
const STATE_FILENAME = '.pe-plan.json'

function statePath(cwd: string): string {
  return join(cwd, STATE_FILENAME)
}

/** Normalize a file path for reliable archive matching (no `./` prefix, forward slashes). */
function normalizeFile(file: string): string {
  let f = file.trim().replace(/\\/g, '/')
  while (f.startsWith('./')) f = f.slice(2)
  while (f.startsWith('/')) f = f.slice(1)
  return f
}

/** Read the persisted project state; undefined when absent or unreadable. */
async function readState(cwd: string): Promise<ProjectState | undefined> {
  try {
    const raw = await readFile(statePath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as ProjectState
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.modules)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/** Write the project state; failure is non-fatal (never breaks the pipeline). */
async function writeState(cwd: string, state: ProjectState): Promise<void> {
  try {
    await writeFile(statePath(cwd), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // Non-fatal: an archive write failure must not fail the whole /pe.
  }
}

/** Keywords that mark a "delete this module" task. */
const DELETE_HINTS = ['删除', '移除', '删掉', '去掉', '弃用']

/**
 * Merge the just-planned tasks into the previous state.
 * - A task whose files intersect an existing module's files is a revision
 *   (overwrite description, UNION the file lists).
 * - A task marked as a deletion removes the matching module.
 * - Otherwise the task is appended as a new module.
 * - The overall goal is preserved from the prior state (a later /pe's plan
 *   goal is the SUB-goal, not the project's root goal).
 */
function mergeState(old: ProjectState | undefined, plan: Plan): ProjectState {
  const modules = (old?.modules ?? []).map(module => ({ ...module, files: [...module.files] }))
  for (const task of plan.tasks) {
    const files = (task.files ?? []).map(normalizeFile).filter(file => file.length > 0)
    const idx = modules.findIndex(module => module.files.some(file => files.includes(file)))
    const isDelete = DELETE_HINTS.some(hint => task.description.includes(hint))
    if (idx >= 0 && isDelete) {
      modules.splice(idx, 1)
    } else if (idx >= 0) {
      modules[idx] = {
        task_id: task.task_id,
        description: task.description,
        files: [...new Set([...modules[idx].files, ...files])],
      }
    } else if (files.length > 0) {
      modules.push({ task_id: task.task_id, description: task.description, files })
    }
    // files empty with no match → cannot locate, skip (do not append junk).
  }
  return { goal: old?.goal ?? plan.goal, modules }
}

/** Render the persisted state as planner prompt context (ordinal index, not task_id, to avoid cross-run id collisions). */
function renderStatePrompt(state: ProjectState): string {
  const lines: string[] = [`现有项目：${state.goal}`, '已完成模块：']
  state.modules.forEach((module, index) => {
    const files = module.files.length > 0 ? ` → ${module.files.join(', ')}` : ''
    lines.push(`${index + 1}. ${module.description}${files}`)
  })
  return lines.join('\n')
}

/** One durable text block for a child's user message. */
function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Join the text blocks of a child's final output. */
function extractText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * 读取会话里最后一条 AI（assistant）消息文本，用于 /pe 不带参数时，
 * 自动把"刚总结好的需求"作为输入（免复制粘贴）。
 */
function readLastAssistantText(events: readonly unknown[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: string; data?: { message?: { content?: unknown } } } | undefined
    if (event === undefined || event.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (Array.isArray(content)) {
      const text = extractText(content as ContentBlock[]).trim()
      if (text.length > 0) return text
    }
  }
  return ''
}

/**
 * Parse JSON from a model's text output, tolerating the common shapes it wraps
 * the value in: a fenced ```` ```json ```` block, a bare `{...}` / `[...]`
 * object embedded among prose (fence open but trailing text after it), and a
 * plain JSON value. Returns `undefined` when nothing parses.
 */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  // 1. Whole message is exactly one fenced block.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu.exec(trimmed)
  if (fenced?.[1] !== undefined) {
    const parsed = parseJson(fenced[1])
    if (parsed !== undefined) return parsed
  }

  // 2. First balanced-looking `{...}` or `[...]` run, even with prose around it.
  const object = /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(trimmed)
  if (object?.[1] !== undefined) {
    try {
      return JSON.parse(object[1])
    } catch {
      // fall through to the direct attempt
    }
  }

  // 3. The raw message itself.
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/**
 * Sleep for `ms`, resolving early when `signal` aborts so a cancelled pipeline
 * never idles out the tail of its pacing delay.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Jitter a delay by ±30% so concurrent tasks never start in lockstep. */
function jitteredDelay(ms: number): number {
  if (ms <= 0) return 0
  const spread = ms * 0.3
  return ms + (Math.random() * 2 - 1) * spread
}

/** Stable Kahn topological sort over `depend_on`; cycles fall back to input order. */
function topoOrder(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map(task => [task.task_id, task]))
  const indegree = new Map(tasks.map(task => [task.task_id, 0]))
  const dependents = new Map(tasks.map(task => [task.task_id, [] as string[]]))
  for (const task of tasks) {
    for (const dep of task.depend_on ?? []) {
      if (!byId.has(dep)) continue
      indegree.set(task.task_id, (indegree.get(task.task_id) ?? 0) + 1)
      dependents.get(dep)?.push(task.task_id)
    }
  }
  const ready = tasks
    .filter(task => (indegree.get(task.task_id) ?? 0) === 0)
    .map(task => task.task_id)
  const ordered: PlanTask[] = []
  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    const task = byId.get(id)
    if (task !== undefined) ordered.push(task)
    for (const next of dependents.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, degree)
      if (degree === 0) ready.push(next)
    }
  }
  const seen = new Set(ordered.map(task => task.task_id))
  for (const task of tasks) if (!seen.has(task.task_id)) ordered.push(task)
  return ordered
}

/**
 * Start one child on `config.provider` with the given model and thinking
 * effort. The fixed instruction rides in the per-child `persona` (system
 * position, identical across children → KV-cache reuse); only the dynamic task
 * text goes in the user `prompt`. The child's session id is recorded with its
 * effort so the `agent/request` waterfall can inject it precisely.
 */
async function spawn(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  model: string,
  effort: Effort,
  childEfforts: ChildEfforts,
  promptText: string,
  personaText: string,
  outputSchema?: ObjectJsonSchema,
  labelSuffix?: string,
  stopSignal?: AbortSignal,
): Promise<SubagentRun> {
  const run = await ctx.subagents.start(config.provider, {
    label: `pe:${model}${labelSuffix === undefined ? '' : `·${labelSuffix}`}`,
    persona: personaText,
    prompt: [textBlock(promptText)],
    parent: invocation.agent,
    signal: stopSignal === undefined ? invocation.signal : AbortSignal.any([invocation.signal, stopSignal]),
    agentOptions: { provider: config.llmProvider, model },
    maxDepth: config.maxDepth,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  })
  childEfforts.set(run.localAgent?.id ?? run.id, effort)
  return run
}

/** Signals a per-attempt executor timeout (distinct from a child fault). */
class ExecutorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`子任务超时（${Math.round(timeoutMs / 1000)}s）`)
    this.name = 'ExecutorTimeoutError'
  }
}

/**
 * Await a child's result with a hard per-attempt timeout. On expiry the run is
 * disposed — which cancels the child's remaining work and reaches quiescence —
 * and the attempt fails with a timeout message the caller can retry. A
 * child-level infrastructure fault (a `run.result` rejection the seam cannot
 * represent as a stop reason) is preserved as `stopReason: 'error'`, never
 * misread as a timeout.
 */
async function settleWithTimeout(
  run: SubagentRun,
  childEfforts: ChildEfforts,
  timeoutMs: number,
): Promise<SubagentResult & { timedOut: boolean; fault?: unknown }> {
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([
      run.result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExecutorTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
    return { ...result, timedOut: false }
  } catch (error: unknown) {
    if (error instanceof ExecutorTimeoutError) {
      return { stopReason: 'aborted', output: [], timedOut: true } as SubagentResult & { timedOut: true }
    }
    // run.result rejected: an infrastructure fault, not a child-level failure.
    return { stopReason: 'error', output: [], timedOut: false, fault: error } as SubagentResult & { timedOut: false; fault: unknown }
  } finally {
    clearTimeout(timer)
    childEfforts.delete(run.localAgent?.id ?? run.id)
    // Cancel any remaining child work on both the timeout and early-return paths.
    await run.dispose()
  }
}

// ── fixed instructions ─────────────────────────────────────────────────────
// Each is mounted as the child's `persona` (system position, cache-stable).
// Keep them static; dynamic data goes in the user `prompt`.

const PLANNER_INSTRUCTION = [
  '你是任务规划器。把下面的用户需求拆解为可独立执行的子任务，输出严格 JSON，禁止任何额外解释或 markdown 代码块。',
  '结构：{"goal":"整体目标","constraints":["约束"],"tasks":[{"task_id":"T001","description":"足够明确的单步指令","output_format":"text|json|markdown","depend_on":[],"files":["涉及的文件路径"]}]}',
  '规则：一个子任务只做一件事；depend_on 填依赖的 task_id；不要生成模糊指令。',
  '每个子任务必须用 files 字段声明它将要创建或修改的文件路径（相对工作区），这是后续增量迭代的关键依据，不能省略。文件路径用相对路径，不要带 ./ 前缀，统一用正斜杠 /。',
  '若需求里给出了「现有项目现状」（已有模块及文件清单），你必须只拆本次需求相关的新任务或修改任务；已完成的模块不要重复拆解，只在其需要被修改时才列入，并在 files 里指向对应文件。',
  '注意：用户需求已经过澄清确认，直接拆解即可，不要向用户提问；若仍有无法确定的关键点，把它写进 constraints 作为假设条件，并在任务中做出合理默认。',
].join('\n')

const EXECUTOR_INSTRUCTION = [
  '你是任务执行者。只完成当前 task_id 对应的这一件事，不要擅自扩展、不要修改目标。',
  '遵守指定的 output_format 输出。若输入信息不足，输出：ERROR:信息不足。',
  '必须真实调用文件/命令工具在沙箱内完成操作（创建/读写文件、运行命令），不能只在回复里描述做法。',
  '若目标文件已存在，先调用 read 工具读取它，再覆盖写入。',
  '若操作被沙箱拒绝（如目标在工作区之外），明确报告被拒原因，不要假装成功。',
].join('\n')

const REVIEW_INSTRUCTION = [
  '你是结果审核专家。对比原始目标和约束，检查每个子任务的产出。',
  '只输出 JSON：{"pass":true|false,"retry_task_ids":[],"problems":[]}，不要其他文字。',
].join('\n')

function plannerPrompt(task: string): string {
  return `用户需求：${task}`
}

function executorPrompt(task: PlanTask, deps: TaskResult[] = []): string {
  const lines = [
    `task_id: ${task.task_id}`,
    `任务描述：${task.description}`,
    `要求输出格式：${task.output_format ?? 'text'}`,
  ]
  if (deps.length > 0) {
    lines.push('', '上游任务产出（直接复用，不要重新推导）：')
    for (const dep of deps) {
      lines.push('', `【${dep.task_id}】${dep.ok ? '' : '(该上游任务失败) '}${dep.text}`)
    }
  }
  return lines.join('\n')
}

function reviewPrompt(plan: Plan, results: TaskResult[]): string {
  return JSON.stringify({ goal: plan.goal, constraints: plan.constraints, results }, null, 2)
}

// ── phases ──────────────────────────────────────────────────────────────────

async function planPhase(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  task: string,
  childEfforts: ChildEfforts,
): Promise<Plan> {
  const run = await spawn(
    ctx, config, invocation,
    config.plannerModel, config.plannerEffort, childEfforts,
    plannerPrompt(task), PLANNER_INSTRUCTION, PLAN_SCHEMA,
  )
  const result = await settleWithTimeout(run, childEfforts, config.executorTimeoutMs)
  if (result.stopReason !== 'completed' || result.timedOut) {
    throw new Error(`planner failed: ${result.stopReason}${result.timedOut ? `（超时 ${Math.round(config.executorTimeoutMs / 1000)}s）` : ''}`)
  }
  const plan = (result.structured ?? parseJson(extractText(result.output))) as Plan | undefined
  if (plan === undefined || !Array.isArray(plan.tasks) || typeof plan.goal !== 'string') {
    throw new Error('planner returned no parseable plan')
  }
  if (plan.tasks.length === 0) {
    throw new Error('planner returned an empty task list')
  }
  return plan
}

async function executeOne(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  task: PlanTask,
  deps: TaskResult[],
  childEfforts: ChildEfforts,
  stopSignal?: AbortSignal,
): Promise<TaskResult> {
  await sleep(jitteredDelay(config.stepIntervalMs), invocation.signal)
  const flashAttempts = config.maxRetries + 1
  let lastFailure = ''
  const taskStart = Date.now()
  for (let attempt = 0; attempt <= flashAttempts; attempt += 1) {
    // A cancelled invocation or a user stop aborts the loop immediately.
    if (invocation.signal.aborted || stopSignal?.aborted === true) {
      return { task_id: task.task_id, ok: false, text: '已停止', model: '—', elapsedMs: Date.now() - taskStart }
    }
    // Flash for attempts 0..maxRetries, then the planner model as the final fallback.
    const model = attempt < flashAttempts ? config.executorModel : config.plannerModel
    // The fallback runs on the planner model, so it takes the planner effort.
    const effort = attempt < flashAttempts ? config.executorEffort : config.plannerEffort
    try {
      const run = await spawn(
        ctx, config, invocation,
        model, effort, childEfforts,
        executorPrompt(task, deps), EXECUTOR_INSTRUCTION,
        undefined, task.task_id, stopSignal,
      )
      const result = await settleWithTimeout(run, childEfforts, config.executorTimeoutMs)
      if (result.stopReason === 'completed') {
        return { task_id: task.task_id, ok: true, text: extractText(result.output), model, elapsedMs: Date.now() - taskStart }
      }
      if (invocation.signal.aborted || stopSignal?.aborted === true) {
        return { task_id: task.task_id, ok: false, text: '已停止', model, elapsedMs: Date.now() - taskStart }
      }
      // 超时 → 可重试的第一级兜底；基础设施故障保留原始错误。
      if (result.timedOut) {
        lastFailure = `超时（${Math.round(config.executorTimeoutMs / 1000)}s）`
      } else if (result.fault !== undefined) {
        lastFailure = result.fault instanceof Error ? result.fault.message : String(result.fault)
      } else {
        lastFailure = `stopReason=${result.stopReason}`
      }
    } catch (error: unknown) {
      if (invocation.signal.aborted || stopSignal?.aborted === true) {
        return { task_id: task.task_id, ok: false, text: '已停止', model, elapsedMs: Date.now() - taskStart }
      }
      lastFailure = error instanceof Error ? error.message : String(error)
    }
  }
  // 所有尝试（Flash 重试 + Pro 兜底）都失败/超时 → 明确失败，绝不卡住。
  return { task_id: task.task_id, ok: false, text: lastFailure, model: config.plannerModel, elapsedMs: Date.now() - taskStart }
}

async function executePhase(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  plan: Plan,
  childEfforts: ChildEfforts,
  stopSignal?: AbortSignal,
): Promise<TaskResult[]> {
  const ordered = topoOrder(plan.tasks)
  const results = new Array<TaskResult>(ordered.length)
  const resultById = new Map<string, TaskResult>()
  const done = new Set<string>()
  const dispatched = new Set<string>()
  const knownIds = new Set(ordered.map(task => task.task_id))
  const workerCount = Math.min(Math.max(1, config.maxConcurrency), ordered.length)

  // A task is ready only once every listed dependency has completed; unknown
  // ids are ignored, matching `topoOrder`'s cycle/unknown handling.
  const isReady = (task: PlanTask): boolean =>
    (task.depend_on ?? []).every(dep => !knownIds.has(dep) || done.has(dep))

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      // A cancelled invocation or a user stop stops the scan.
      if (invocation.signal.aborted || stopSignal?.aborted === true) break
      // Synchronous scan-and-claim (no `await` inside) so two workers cannot
      // grab the same task; the `stepIntervalMs` jitter still runs inside
      // `executeOne`, preserving the rate-limit ramp.
      let index = -1
      for (let i = 0; i < ordered.length; i += 1) {
        const candidate = ordered[i]
        if (candidate === undefined || dispatched.has(candidate.task_id)) continue
        if (isReady(candidate)) { index = i; break }
      }
      if (index < 0) {
        // No ready task yet undispatched work remains: the plan contains a
        // dependency cycle (or a chain that can never resolve). Claim the first
        // undispatched task and run it with whatever upstream results exist so
        // the cycle can never deadlock or silently drop tasks.
        for (let i = 0; i < ordered.length; i += 1) {
          const candidate = ordered[i]
          if (candidate === undefined || dispatched.has(candidate.task_id)) continue
          index = i
          break
        }
      }
      if (index < 0) break
      const task = ordered[index]
      if (task === undefined) break
      dispatched.add(task.task_id)

      const deps: TaskResult[] = (task.depend_on ?? [])
        .map(id => resultById.get(id))
        .filter((result): result is TaskResult => result !== undefined)
      const result = await executeOne(ctx, config, invocation, task, deps, childEfforts, stopSignal)
      results[index] = result
      resultById.set(task.task_id, result)
      done.add(task.task_id)
    }
  })
  await Promise.all(workers)
  return results
}

async function reviewPhase(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  plan: Plan,
  results: TaskResult[],
  childEfforts: ChildEfforts,
): Promise<ReviewVerdict> {
  const run = await spawn(
    ctx, config, invocation,
    config.reviewerModel, config.reviewerEffort, childEfforts,
    reviewPrompt(plan, results), REVIEW_INSTRUCTION,
  )
  const result = await settleWithTimeout(run, childEfforts, config.executorTimeoutMs)
  if (result.stopReason !== 'completed' || result.timedOut) {
    return { pass: false, retryTaskIds: [], problems: [`review failed: ${result.stopReason}`] }
  }
  const raw = parseJson(extractText(result.output)) as Record<string, unknown> | undefined
  if (raw !== undefined && typeof raw.pass === 'boolean') {
    // The reviewer prompt asks for snake_case `retry_task_ids`; accept the
    // camelCase twin too so either spelling survives.
    const retry = (raw.retry_task_ids ?? raw.retryTaskIds) as unknown
    return {
      pass: raw.pass,
      retryTaskIds: Array.isArray(retry) ? retry.map(String) : [],
      problems: Array.isArray(raw.problems) ? raw.problems.map(String) : [],
    }
  }
  return { pass: true, retryTaskIds: [], problems: [] }
}

function renderSummary(plan: Plan, results: TaskResult[], verdict: ReviewVerdict | undefined): string {
  const succeeded = results.filter(result => result !== undefined && result.ok).length
  const totalMs = results.reduce((sum, r) => sum + (r?.elapsedMs ?? 0), 0)
  const lines: string[] = [
    `/pe 完成 — 目标：${plan.goal}`,
    `子任务 ${results.length} 个，成功 ${succeeded} 个，总耗时 ${(totalMs / 1000).toFixed(1)}s`,
  ]
  for (const result of results) {
    if (result === undefined) continue
    const elapsed = result.elapsedMs !== undefined ? `（${(result.elapsedMs / 1000).toFixed(1)}s）` : ''
    lines.push(`\n【${result.task_id}】${result.ok ? '✓' : '✗'}${elapsed}（${result.model}）\n${result.text}`)
  }
  if (verdict !== undefined) {
    lines.push(`\n复核：${verdict.pass ? '通过' : `未通过 — ${verdict.problems.join('；')}`}`)
  }
  return lines.join('\n')
}

/** Render the plan as a short markdown detail for the approval question. */
function renderPlanDetail(plan: Plan): string {
  const lines: string[] = [`目标：${plan.goal}`]
  if (plan.constraints.length > 0) {
    lines.push('', '约束：')
    for (const constraint of plan.constraints) lines.push(`- ${constraint}`)
  }
  lines.push('', `子任务（共 ${plan.tasks.length} 个）：`)
  for (const task of plan.tasks) {
    const deps = task.depend_on !== undefined && task.depend_on.length > 0 ? `（依赖：${task.depend_on.join(', ')}）` : ''
    lines.push(`- ${task.task_id}${deps}：${task.description}`)
  }
  return lines.join('\n')
}

/** Ask the user to approve the plan before any executor runs. */
async function confirmPlan(
  ctx: Context,
  invocation: CommandInvocation,
  plan: Plan,
  fullAnswer: string,
): Promise<{ action: 'execute' | 'cancel' | 'revise'; reviseText: string }> {
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: 'pe_confirm',
      question: '计划已生成，确认执行、取消，或填写修改要求：',
      detail: `需求：${fullAnswer}\n\n${renderPlanDetail(plan)}\n\n若需修改，请直接在下方输入（例如：T003 改成柱状图）。`,
      options: [
        { label: '执行', description: '按计划并行执行子任务' },
        { label: '取消', description: '不执行任何子任务，结束本次 /pe' },
      ],
      intent: { kind: 'plan-review', approve: '执行' },
    }],
    agent: invocation.agent,
    signal: invocation.signal,
  })
  const item = answer.answers.find(entry => entry.id === 'pe_confirm')
  const selected = item?.selected ?? []
  const custom = item?.custom?.trim() ?? ''
  if (selected.includes('执行')) {
    return { action: 'execute', reviseText: '' }
  }
  if (custom.length > 0) {
    return { action: 'revise', reviseText: custom }
  }
  return { action: 'cancel', reviseText: '' }
}

/** One diagnosis item: which subtask to fix, why, and its revised description. */
interface FixItem {
  task_id: string
  reason: string
  revised_description: string
}

/** The LLM's diagnosis: which subtasks to re-run and how. */
interface FixPlan {
  tasks: FixItem[]
}

/** Object-rooted JSON schema for the fix-diagnosis structured output. */
const FIX_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id', 'reason', 'revised_description'],
        properties: {
          task_id: { type: 'string' },
          reason: { type: 'string' },
          revised_description: { type: 'string' },
        },
      },
    },
  },
}

const FIX_INSTRUCTION = [
  '你是任务诊断专家。用户对已完成的结果提出不满或改进要求，你只负责判断：哪个子任务需要重新执行、应该改造成什么样。不要真的执行，只输出诊断方案。',
  '用户会给出：原始目标、各子任务的产出、以及他的问题/要求。',
  '规则：只改动真正受用户问题影响的子任务，未被影响的子任务不要列入；rest_reason 用一句话说明为什么改它；revised_description 写清楚修改后该子任务要重新做什么（足够明确，供执行者照做）。',
  '若用户的问题不针对任何现有子任务，或信息不足无法定位，输出空数组 tasks。',
].join('\n')

/**
 * 完工询问：展示结果，让用户描述不满/要求（而不是勾选）。
 * 返回用户是否满意、以及描述的问题文本。
 */
async function askSatisfaction(
  ctx: Context,
  invocation: CommandInvocation,
  plan: Plan,
  results: TaskResult[],
): Promise<{ satisfied: boolean; problem: string }> {
  const byId = new Map(plan.tasks.map(task => [task.task_id, task]))
  const resultLines = results
    .filter(result => result !== undefined)
    .map(result => {
      const desc = byId.get(result.task_id)?.description ?? ''
      return `- ${result.task_id} ${result.ok ? '✓' : '✗'}：${desc}`
    })
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: 'pe_satis',
      question: '全部完成。满意吗？如有要调整的地方，请直接在下框描述你的问题/要求。',
      detail: `结果：\n${resultLines.join('\n')}\n\n满意请选「结束」；要改就直接描述问题（例如：报表格式不对，我需要柱状图；T003 的数据有误）。`,
      options: [
        { label: '结束（满意）', description: '保留当前结果，结束' },
      ],
    }],
    agent: invocation.agent,
    signal: invocation.signal,
  })
  const item = answer.answers.find(entry => entry.id === 'pe_satis')
  const selected = item?.selected ?? []
  const custom = item?.custom?.trim() ?? ''
  if (selected.includes('结束（满意）')) {
    return { satisfied: true, problem: '' }
  }
  // 未选结束但有补充说明 → 视为用户提出了问题。
  if (custom.length > 0) {
    return { satisfied: false, problem: custom }
  }
  // 未选结束也没填什么 → 视为满意结束。
  return { satisfied: true, problem: '' }
}

/**
 * LLM 诊断：根据用户描述的问题，判断哪个子任务要改、怎么改（只给方案，不执行）。
 */
async function diagnoseFix(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  plan: Plan,
  results: TaskResult[],
  problem: string,
  childEfforts: ChildEfforts,
): Promise<FixPlan> {
  const byId = new Map(plan.tasks.map(task => [task.task_id, task]))
  const resultLines = results
    .filter(result => result !== undefined)
    .map(result => {
      const desc = byId.get(result.task_id)?.description ?? ''
      const outcome = result.ok ? '成功' : '失败'
      const snippet = result.text.length > 160 ? `${result.text.slice(0, 160)}…` : result.text
      return `【${result.task_id}】${desc}\n状态：${outcome}\n产出：${snippet}`
    })
  const prompt = [
    `原始目标：${plan.goal}`,
    `用户问题/要求：${problem}`,
    '',
    '各子任务产出：',
    resultLines.join('\n'),
  ].join('\n')
  const run = await spawn(
    ctx, config, invocation,
    config.plannerModel, config.clarifyEffort, childEfforts,
    prompt, FIX_INSTRUCTION, FIX_SCHEMA, 'fix-diagnose',
  )
  const result = await settleWithTimeout(run, childEfforts, config.executorTimeoutMs)
  if (result.stopReason !== 'completed' || result.timedOut) {
    return { tasks: [] }
  }
  const raw = (result.structured ?? parseJson(extractText(result.output))) as FixPlan | undefined
  if (raw === undefined || !Array.isArray(raw.tasks)) {
    return { tasks: [] }
  }
  const knownIds = new Set(plan.tasks.map(task => task.task_id))
  const tasks = raw.tasks
    .filter(item => item !== undefined && knownIds.has(item.task_id)
      && typeof item.revised_description === 'string' && item.revised_description.length > 0)
    .map(item => ({
      task_id: item.task_id,
      reason: typeof item.reason === 'string' ? item.reason : '',
      revised_description: item.revised_description,
    }))
  return { tasks }
}

/**
 * 方案确认：展示诊断出的修改方案，请用户确认是否执行。
 */
async function confirmFix(
  ctx: Context,
  invocation: CommandInvocation,
  fix: FixPlan,
): Promise<boolean> {
  const lines = fix.tasks.map(item => {
    const reason = item.reason.length > 0 ? `\n  原因：${item.reason}` : ''
    return `- ${item.task_id}${reason}\n  修改后：${item.revised_description}`
  })
  const answer = await ctx.userQuestions.ask({
    questions: [{
      id: 'pe_fixconfirm',
      question: '诊断到以下修改方案，是否执行？',
      detail: `建议修改 ${fix.tasks.length} 个子任务（其余保留）：\n${lines.join('\n')}`,
      options: [
        { label: '确认执行', description: '只重跑上述子任务，其他结果保留' },
        { label: '放弃修改', description: '不重跑，保留当前结果结束' },
      ],
    }],
    agent: invocation.agent,
    signal: invocation.signal,
  })
  const item = answer.answers.find(entry => entry.id === 'pe_fixconfirm')
  const selected = item?.selected ?? []
  return selected.includes('确认执行')
}

async function run(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
  childEfforts: ChildEfforts,
): Promise<CommandResult> {
  let task = invocation.rawInput.trim()
  if (task.length === 0) {
    // /pe 不带参数：读取会话里最后一条 AI 总结作为需求（免复制粘贴）。
    task = readLastAssistantText(invocation.agent.session.events as readonly unknown[])
    if (task.length === 0) {
      return { kind: 'error', text: '用法：/pe <需求描述>，或先在对话里让 AI 总结需求，再直接输入 /pe' }
    }
  }
  const signal = invocation.signal
  try {
    // 需求已在普通对话里明确，/pe 直接规划（不再弹"需求确认"）。
    // 增量迭代：读取工作区已有的项目档案，注入规划器作为"现状"，
    // 让规划器只拆本次需求相关的新/改任务，不重做已完成模块。
    const cwd = invocation.agent.session.header.cwd
    const priorState = cwd === undefined ? undefined : await readState(cwd)
    const planInput = priorState === undefined
      ? task
      : `【现有项目现状】\n${renderStatePrompt(priorState)}\n\n【本次需求】\n${task}`

    let plan = await planPhase(ctx, config, invocation, planInput, childEfforts)
    if (signal.aborted) return { kind: 'error', text: '已停止' }

    if (config.confirm) {
      // 计划确认 + 可修改循环：用户可确认执行/取消，或填写修改要求重新规划。
      let reviseHistory = ''
      for (;;) {
        const decision = await confirmPlan(ctx, invocation, plan, task)
        if (signal.aborted) return { kind: 'error', text: '已停止' }
        if (decision.action === 'cancel') {
          return { kind: 'success', text: '已取消，未执行任何子任务。' }
        }
        if (decision.action === 'execute') break
        // 修改：累积修改要求，重新规划，再展示计划。
        reviseHistory += `\n\n【用户修改要求】${decision.reviseText}`
        plan = await planPhase(ctx, config, invocation, `${planInput}${reviseHistory}`, childEfforts)
        if (signal.aborted) return { kind: 'error', text: '已停止' }
      }
    }

    // 执行阶段：并发弹「停止」监控框，用户可随时中断剩余子任务。
    const stopController = new AbortController()
    const askCancel = new AbortController()
    const stopMonitor = (async () => {
      try {
        await ctx.userQuestions.ask({
          questions: [{
            id: 'pe_stop',
            question: '任务执行中…',
            detail: '可随时点「停止」立即中断剩余子任务（已完成的保留）。',
            options: [
              { label: '停止', description: '立即停止剩余子任务' },
            ],
          }],
          agent: invocation.agent,
          signal: askCancel.signal,
        })
        stopController.abort()
      } catch {
        // 执行完成，监控框被取消。
      }
    })()

    let results = await executePhase(ctx, config, invocation, plan, childEfforts, stopController.signal)
    askCancel.abort()
    await stopMonitor.catch(() => {})
    if (signal.aborted) return { kind: 'error', text: '已停止' }
    if (stopController.signal.aborted) {
      // 用户主动停止：跳过复核/完工验收，直接返回已完成的结果。
      const doneCount = results.filter(r => r !== undefined).length
      return { kind: 'success', text: `已停止执行（完成 ${doneCount}/${plan.tasks.length} 个子任务）。\n\n${renderSummary(plan, results, undefined)}` }
    }

    let verdict: ReviewVerdict | undefined
    if (config.review) {
      verdict = await reviewPhase(ctx, config, invocation, plan, results, childEfforts)
      if (signal.aborted) return { kind: 'error', text: '已停止' }
    }

    // 完工验收：问用户是否满意；不满意则描述问题 → LLM 诊断改哪个子任务 → 出方案确认 → 只重跑选中项。
    for (let round = 0; round < config.maxFixRounds; round += 1) {
      if (signal.aborted) return { kind: 'error', text: '已停止' }

      const satis = await askSatisfaction(ctx, invocation, plan, results)
      if (signal.aborted) return { kind: 'error', text: '已停止' }
      if (satis.satisfied) break

      // 用户描述了问题 → LLM 诊断哪个子任务要改、怎么改（只给方案）。
      const fix = await diagnoseFix(ctx, config, invocation, plan, results, satis.problem, childEfforts)
      if (signal.aborted) return { kind: 'error', text: '已停止' }
      if (fix.tasks.length === 0) {
        return { kind: 'success', text: `未定位到需修改的子任务：${satis.problem}\n\n${renderSummary(plan, results, verdict)}` }
      }

      // 先出方案，确认后才执行。
      const confirmed = await confirmFix(ctx, invocation, fix)
      if (signal.aborted) return { kind: 'error', text: '已停止' }
      if (!confirmed) break

      const fixById = new Map(fix.tasks.map(item => [item.task_id, item]))
      const retryTasks = plan.tasks
        .filter(task => fixById.has(task.task_id))
        .map(task => ({
          ...task,
          description: fixById.get(task.task_id)?.revised_description ?? task.description,
        }))
      if (retryTasks.length === 0) break

      // 把诊断后的新描述同步回 plan，确保档案记录的是最终版任务。
      for (const item of fix.tasks) {
        const target = plan.tasks.find(task => task.task_id === item.task_id)
        if (target !== undefined) target.description = item.revised_description
      }

      const retried = await executePhase(ctx, config, invocation, { ...plan, tasks: retryTasks }, childEfforts)
      if (signal.aborted) return { kind: 'error', text: '已停止' }
      for (const item of retried) {
        const at = results.findIndex(existing => existing.task_id === item.task_id)
        if (at >= 0) results[at] = item
        else results.push(item)
      }
      if (config.review) {
        verdict = await reviewPhase(ctx, config, invocation, plan, results, childEfforts)
        if (signal.aborted) return { kind: 'error', text: '已停止' }
      }
    }
    // 完工后写项目档案，供下次 /pe 增量迭代（加/改功能时只动受影响模块）。
    if (cwd !== undefined) {
      await writeState(cwd, mergeState(priorState, plan))
    }
    return { kind: 'success', text: renderSummary(plan, results, verdict) }
  } catch (error: unknown) {
    if (signal.aborted) return { kind: 'error', text: '已停止' }
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

export function apply(ctx: Context, config: Config): void {
  // Per-instance child-effort map: the ONLY scope the thinking override applies
  // to. Children spawned by THIS plugin instance get their effort recorded at
  // spawn and cleared at settle, so ordinary chat and other plugins are never
  // touched, and a planner/reviewer sharing one model still map to their own
  // effort level (no model-string guessing).
  const childEfforts: ChildEfforts = new Map()

  // Thinking is adapter-global (`llm-deepseek` `thinking`/`reasoningEffort`)
  // and cannot ride `agentOptions` (provider/model/maxTokens only). Inject it
  // per request through the `agent/request` waterfall, keyed on the exact child
  // session id recorded at spawn.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const effort = childEfforts.get(payload.agent.id)
    if (effort === undefined) return resolved
    return { ...resolved, reasoningEffort: effort as ReasoningEffortId }
  })

  ctx.commands.register({
    name: 'pe',
    description: 'Pro plans, Flash executes, Pro reviews — a rate-limit-friendly Plan-and-Execute pipeline',
    input: { hint: '<task description>' },
    handler: invocation => run(ctx, config, invocation, childEfforts),
  })
}
