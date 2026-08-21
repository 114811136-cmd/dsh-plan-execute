# dsh-plan-execute

一个 DeepSeek Harness 插件：注册 `/pe` 命令，触发「Pro 规划 → Flash 执行 → Pro 复核」的 Plan-and-Execute 流程。全程基于 Harness 的 subagent 机制（`spawn` 子代理 + 按委托覆盖 model），不外部调度、不改 loop、不手动切模型。

## 用法

在 Web GUI 聊天框输入：

```
/pe 写一份电商调味品拼多多标题，产出 5 条满字标题
```

平时照常使用；只有敲 `/pe` 才走三段式流程。

## 流程

1. **规划**：`deepseek-v4-pro` 子代理 → 结构化 JSON 计划（目标/约束/子任务）。
2. **执行**：`deepseek-v4-flash` 子代理逐个执行；受 `maxConcurrency` 与 `stepIntervalMs` 约束，Flash 重试 `maxRetries` 次后改 Pro 兜底。
3. **复核**：`deepseek-v4-pro` 子代理校验产出；可关（`review: false`）。

## 安装

### 从 GitHub 安装（推荐，跨电脑一条命令）

```sh
# 新电脑装好同版本 dsh 后，一条命令即可（lib/ 已提交，无需构建授权）：
dsh plugin --profile web add github:<你的用户名>/dsh-plan-execute
# 重启或热载入 web 后，聊天框斜杠菜单出现 /pe
```

私有仓库需目标电脑已配置 GitHub 凭据；公开仓库任何机器直接可用。

### 从本地路径安装

```sh
dsh plugin --profile web add <本包路径或 git 地址>
# 重启或热载入 web 后，聊天框斜杠菜单出现 /pe
```

### 从 tarball 安装（无网络/无 GitHub）

```sh
pnpm pack            # 生成 dsh-plan-execute-0.1.0.tgz
dsh plugin --profile web add ./dsh-plan-execute-0.1.0.tgz
```

> 注意：`lib/` 构建产物已**提交进仓库**（见 `.gitignore`），所以任何安装方式都不需要目标机器运行构建脚本或授权 `prepare`。

## 可配置项（cordis.yml）

| 字段 | 默认 | 作用 |
|---|---|---|
| `provider` | `spawn` | 子代理后端 |
| `llmProvider` | `deepseek-official` | 子代理路由 |
| `plannerModel` | `deepseek-v4-pro` | 规划/复核模型 |
| `executorModel` | `deepseek-v4-flash` | 执行模型 |
| `reviewerModel` | `deepseek-v4-pro` | 复核模型 |
| `maxConcurrency` | `2` | Flash 并发上限（防 `RequestBurstTooFast`） |
| `stepIntervalMs` | `800` | 每步最小间隔（±30% 抖动） |
| `maxRetries` | `2` | Flash 失败重试次数，之后转 Pro |
| `review` | `true` | 是否复核 |
| `plannerEffort` | `high` | 规划阶段 thinking（禁 max） |
| `executorEffort` | `off` | 执行阶段 thinking（强制关，省 token） |
| `reviewerEffort` | `high` | 复核阶段 thinking |
| `maxDepth` | `3` | 子代理深度上限 |

## KV 缓存友好（成本核心）

三段**固定指令**都挂载在子代理的 `persona`（系统位，所有子代理完全一致），**动态任务内容放 user 消息**。连续子代理复用相同 system 前缀 → 命中 DeepSeek KV 缓存，避免每个子任务都为冷输入重复付费。不要把固定指令拼进 user 消息，否则每个子任务都是全新的未命中输入。

## 429 退避说明（勿靠“多重试”）

`RequestBurstTooFast` 是瞬时尖峰保护：短间隔重试会越试越糟。Harness 自带 `llm-retry` 已对 429 做指数退避 + jitter 并尊重 `Retry-After`；插件侧用 `maxConcurrency` + `stepIntervalMs` 从源头压低爆发。如需更缓的退避，在 DeepSeek provider 的 `retryPolicy.backoff` 上调大 `initialDelayMs`（1000–2000）与 `maxDelayMs`（≤16000），`jitterRatio` 0.2–0.5。不要写死固定重试延迟。

## thinking 控制（已实现，注意副作用）

thinking 是 `llm-deepseek` 适配器的**全局默认**，`agentOptions` 带不了。本插件通过 `agent/request` 瀑布按 model 注入 `reasoningEffort`：Flash→`off`、Pro→`high`。

**副作用**：任何用 `deepseek-v4-flash` 的请求（包括普通聊天）都会变为 thinking-off；用 `deepseek-v4-pro` 的会变为 `high`。这符合省钱目标（Flash 思考无增益），但如果你希望普通聊天保持原样，删掉 `apply()` 里的 `agent/request` 监听即可，代价是子代理统一继承适配器默认 thinking。

## 迁移到新电脑（无账号）

1. 装同版本 DSH；
2. 复制本包，`dsh plugin --profile web add <本包路径>`；
3. 在「模型」页重填 `deepseek-v4-pro` / `deepseek-v4-flash` 的 API Key（或复制 `$DSH_HOME/.credentials.yaml`）。

## 发布更新

改完 `src/index.ts` 后重新编译出 `lib/`（当前在 DSH 源码 checkout 里编译），提交并推送：

```sh
git add -A && git commit -m "..." && git push
```

目标电脑重跑 `dsh plugin --profile web add github:<你的用户名>/dsh-plan-execute`（或更新已装的 git 依赖）即可获取新版本。

## 实现前必做的 3 项核对（本骨架未伪造的部分）

1. **构建**：本骨架是 TypeScript 源码；需按仓库约定用 `tsc`/`tsdown` 编译出 `lib/index.js` 与 `lib/types/`（`main`/`types` 已指向 `lib`）。裸 TS 不能被 Loader 直接解析。
2. **打包解析**：`cordis.patch.yml` 的 `name` 必须与本包 `package.json` 的 `name` 一致；`dependencies` 里的 `@deepseek-ai/*` 需能被 profile 解析（`dsh plugin add` 会 reconcile `dsh.profile.bundles`）。装完用 `dsh --profile web --dump-config` 确认 `plan-execute` 行已进入配置树，且 `verify-cordis-config` 通过。
3. **编译与 schema 校验**：`agent/request` 监听与 `PLAN_SCHEMA` 需实际编译通过，且 `PLAN_SCHEMA` 要满足 `assertObjectJsonSchema` 的受限子集（type/properties/required/additionalProperties/items/enum/const/oneOf）；首次挂载时若被拒，按报错调整 schema 字段。

## 验收清单

- [ ] `/pe` 出现在斜杠菜单；
- [ ] 跑一个纯文字任务，三阶段各自显示 `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-pro`；
- [ ] 跑一个带文件/命令操作的任务，确认 Flash 子代理能真正读写、执行（standard 预设默认挂载 `fs`/`pwsh`）；
- [ ] 连发多个子任务不触发 `RequestBurstTooFast`（`maxConcurrency: 2`、`stepIntervalMs: 800` 生效）；
- [ ] 复核打回重做：故意给一个会产出偏差结果的子任务（如让复核明显不通过），确认复核返回 `retry_task_ids` 后，被标记的子任务**只重跑一次**并再次复核，汇总里出现「复核：未通过/通过」的第二次结论，且不会无限循环。
