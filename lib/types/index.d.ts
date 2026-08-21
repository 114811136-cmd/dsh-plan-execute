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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "plan-execute";
export declare const inject: string[];
/** DeepSeek thinking effort levels accepted by the adapter. */
type Effort = 'off' | 'low' | 'high' | 'max';
/**
 * Deployment-varying choices. Every tunable here is a validated `Config` field
 * changeable from `cordis.yml` — never hardcoded at the call site.
 */
export interface Config {
    /** `ctx.subagents` provider name. In-process `spawn` ships in every profile. */
    provider: string;
    /** Provider route used for every child (matches `agent-default-model`). */
    llmProvider: string;
    /** Planner model (global decomposition, structured JSON output). */
    plannerModel: string;
    /** Executor model (bulk, cheap, thinking-off single steps). */
    executorModel: string;
    /** Reviewer model (final verification against the original goal). */
    reviewerModel: string;
    /** Max simultaneous executor children — the primary `RequestBurstTooFast` guard. */
    maxConcurrency: number;
    /** Minimum delay between executor starts, jittered ±30% (gradual traffic growth). */
    stepIntervalMs: number;
    /** Flash retries per subtask before falling back to `plannerModel`. */
    maxRetries: number;
    /** Run the reviewer phase after all subtasks. */
    review: boolean;
    /** Ask the user to approve the plan before executing. */
    confirm: boolean;
    /** Thinking effort for the planner child. */
    plannerEffort: Effort;
    /** Thinking effort for executor children (`off` saves the most tokens). */
    executorEffort: Effort;
    /** Thinking effort for the reviewer child. */
    reviewerEffort: Effort;
    /** Delegation-depth cap passed to every child. */
    maxDepth: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=index.d.ts.map