# 字幕 LLM 后处理：外部大模型接入 + 本地微调模型兜底

日期：2026-05-31
状态：已批准（方案 A），授权自动执行至 PR

## 背景与动机

ASR 字幕生成已可用，但本地微调后处理模型（`ceilf6/code-tape-subtitle-postprocessor-onnx`，q8）参数太小、在浏览器内推理常超时（60s 预算），导致「优化字幕和章节」失败。

本特性在**不影响现有能力**的前提下，给字幕 LLM 后处理阶段加一个配置入口：用户可填写外部大模型（OpenAI / Anthropic）的请求方式、请求地址、API Key、Model。配置后该阶段优先请求外部大模型（能力更强，纠错与章节质量更好且不超时）；未配置或外部请求失败/超时时，自动回退到现有本地微调模型兜底。

产品场景（docs/PRD.md §本地 AI 字幕生成）：code-tape 录制代码讲解，ASR 出带时间戳字幕，LLM 阶段负责①修正前端/代码术语（变量名、函数名、框架名、包名、英文缩写）②基于字幕内容与时间戳自动分段生成章节跳转点。外部大模型复用这两个目标，但输出同一 `{segments, chapters}` JSON 契约以走现有全部校验。

## 关键决策（已与用户确认）

1. **存储/调用**：纯前端 + localStorage，前端直接 `fetch`。UI 明确提示「API Key 仅存本机浏览器、请填支持 CORS 的地址」。跨域/安全由用户填自己的网关或兼容端点解决。不引入后端代理（契合 code-tape 纯静态部署）。
2. **兜底时机**：配置后优先外部；外部失败/超时才自动回退本地。未配置时行为与现状完全一致。
3. **请求格式**：OpenAI（`/v1/chat/completions`，`Authorization: Bearer`）与 Anthropic（`/v1/messages`，`x-api-key` + `anthropic-version`）两种都原生支持，各写一个 adapter。
4. **提示词与输出**：基于 PRD 场景为外部大模型写一份增强 system 提示词（强调代码讲解术语纠错 + 章节生成 + 严格 JSON 输出），但输出**同一** `{segments, chapters}` JSON 契约，复用现有 `extractSubtitleCorrectionResult` + `constrainCorrectionToTrack` 全部解析/校验/约束逻辑。

## 架构（方案 A：组合式后处理器，复用现有注入点）

`SubtitlePostProcessor` 接口（types.ts:59-63）是唯一接缝；`SubtitlePanel` 的 `useMemo`（SubtitlePanel.tsx:66-75）已支持注入。三个边界清晰的小单元：

### 1. 共享逻辑抽取 — `subtitlePostProcessorShared.ts`（新增）
从 `subtitlePostProcessor.ts` 抽出**纯函数**：`buildSubtitlePostProcessorMessages`、`buildSubtitlePostProcessorPayload`、`extractSubtitleCorrectionResult`、`constrainCorrectionToTrack`、`recoverSubtitleCorrectionResult`、`isRecoverableJsonOutputError`、`chunkSubtitleTrack`、`estimateMaxNewTokens` 及其依赖（`budgetPromptText`、术语保真度判定等）。现有 `subtitlePostProcessor.ts` 改为从 shared import，**行为零变化**（纯重构）。

### 2. 配置 — `subtitleLlmConfig.ts`（新增）
- 类型 `ExternalLlmConfig = { provider: "openai" | "anthropic"; baseURL: string; apiKey: string; model: string }`。
- `loadExternalLlmConfig()` / `saveExternalLlmConfig()` / `clearExternalLlmConfig()`：localStorage 键 `code-tape:subtitle-llm`，try/catch（私有模式安全），沿用 `subtitlePostProcessorConfig.ts` 与 themeProvider 的本地存储范式。
- `isExternalLlmConfigured(config)`：四字段非空才算配置完成。

### 3. 外部后端 — `externalLlmSubtitlePostProcessor.ts`（新增）
实现 `SubtitlePostProcessor`，主线程 `fetch`（API Key 不进 worker bundle）：
- `process({track, context, signal})`：复用 shared 构造 messages → 按 provider 走对应 adapter 发请求（透传 `signal`）→ 拿响应文本 → 复用 shared `extractSubtitleCorrectionResult` + `constrainCorrectionToTrack`。长字幕复用 shared `chunkSubtitleTrack` 分块。
- 两个 adapter（同文件内或子函数）：
  - openai：POST `${baseURL}/chat/completions`，body `{model, messages, temperature:0, response_format:{type:"json_object"}}`，header `Authorization: Bearer`。
  - anthropic：POST `${baseURL}/messages`，把 system 消息提到顶层 `system` 字段、其余进 `messages`，body `{model, system, messages, max_tokens}`，header `x-api-key` + `anthropic-version: 2023-06-01`。
- 增强 system 提示词：在现有 system 内容基础上，明确「你是资深前端/代码讲解字幕编辑」「修正变量名/函数名/框架名/包名/英文缩写」「按讲解结构生成章节标题（如问题分析/状态设计/代码实现/调试验证）」「只输出 JSON，segments 只含改动项，chapters 总是数组」。
- 无 `warmUp`（HTTP 无需预热）；无 `dispose`。

### 4. 兜底组合 — `fallbackSubtitlePostProcessor.ts`（新增）
`createFallbackSubtitlePostProcessor(primary, fallback)`：薄包装实现 `SubtitlePostProcessor`。
- `process()`：先 `primary.process()`；catch 到**非 abort** 错误（含超时）→ 调 `fallback.process()`。abort 错误直接抛出（用户取消不该触发兜底）。
- `warmUp()`：只预热 `fallback`（本地模型需预热；外部 HTTP 不需要，预热外部会无谓消耗 token/触发请求）。
- `dispose()`：透传给两者。

### 5. 配置 UI — `SubtitleLlmConfigButton.tsx`（新增）
header（SubtitlePanel.tsx:359 的 flex 容器）加一个齿轮图标按钮 + Radix `Popover`（shared/ui/Popover.tsx 既有）。表单字段：provider（OpenAI/Anthropic 单选）、baseURL、apiKey（password 输入）、model；保存/清除按钮；风险提示文案「API Key 仅保存在本机浏览器；请确保请求地址支持浏览器跨域（CORS）」。保存后回调通知 `SubtitlePanel` 重建 postProcessor。

### 改动 — `SubtitlePanel.tsx`
- `useMemo`（66-75）：当 `injectedPostProcessor === undefined` 时，读 `loadExternalLlmConfig()`：
  - 已配置 → `createFallbackSubtitlePostProcessor(external, workerLocal)`；
  - 未配置 → 现状（仅 `workerLocal`）。
  - 注入 postProcessor（测试/null）路径不变。
- 用一个 config 版本号 state 作为 `useMemo` 依赖，配置保存后自增触发重建。
- header 渲染 `<SubtitleLlmConfigButton>`。

## 数据流

点击主操作 → ASR（不变）→ 后处理：`SubtitlePanel.postProcessSubtitles()` 调 `postProcessor.process()`（已被 `runWithPostProcessTimeout` 包裹 60s + AbortController）。
- 已配置：fallback 包装先发外部 HTTP；成功则用其结果；失败/超时（非用户取消）→ 内部回退本地 worker；本地也失败 → 抛错，`SubtitlePanel` 保留原始 ASR 字幕并展示可恢复错误（现有路径）。
- 未配置：直接走本地 worker（现状）。

## 错误处理

- 外部请求错误分类：网络/CORS 错误、HTTP 非 2xx（401/403/404/429/5xx）、响应非合法 JSON、JSON 不含合法 segments/chapters。除用户 abort 外，均视为「外部失败」触发兜底。
- abort（`signal.aborted` / `AbortError`）：直接向上抛，不触发兜底（用户取消或切换录制）。
- 60s 超时由现有 `runWithPostProcessTimeout` 统一处理，超时 abort 会被 fallback 视为失败→回退本地（本地仍受同一总预算约束；若总预算已耗尽，保留原始字幕）。
- 配置读写：localStorage 不可用（私有模式/禁用）时 try/catch 静默降级为「未配置」。
- 安全：API Key 仅 localStorage；不写日志、不进 metrics、不进 worker；UI 用 password 输入并提示风险。

## 测试

- `subtitleLlmConfig.test.ts`：localStorage 读/写/清除/损坏数据降级；`isExternalLlmConfigured` 边界。
- `externalLlmSubtitlePostProcessor.test.ts`：注入 fake `fetch`；openai/anthropic 两种请求体与 header 正确；响应解析复用 shared 校验；HTTP 错误/非法 JSON 抛错；`signal` abort 透传。
- `fallbackSubtitlePostProcessor.test.ts`：primary 成功不调 fallback；primary 非 abort 失败→调 fallback；primary abort→不调 fallback 直接抛；warmUp 只预热 fallback；dispose 透传。
- `SubtitleLlmConfigButton.test.tsx`：表单渲染、保存写 localStorage、清除、风险提示文案存在。
- `subtitlePostProcessor.test.ts`：现有测试须全绿（验证 shared 抽取无行为变化）。
- 全量 `npm run test -w apps/web` + lint + build。

## 改动文件清单

新增：
- `apps/web/src/features/subtitles/subtitlePostProcessorShared.ts`
- `apps/web/src/features/subtitles/subtitleLlmConfig.ts`
- `apps/web/src/features/subtitles/externalLlmSubtitlePostProcessor.ts`
- `apps/web/src/features/subtitles/fallbackSubtitlePostProcessor.ts`
- `apps/web/src/features/subtitles/SubtitleLlmConfigButton.tsx`
- 对应 5 个 `__tests__/*.test.ts(x)`

改：
- `apps/web/src/features/subtitles/subtitlePostProcessor.ts`（改为从 shared import，纯重构）
- `apps/web/src/features/subtitles/SubtitlePanel.tsx`（useMemo 选择逻辑 + header 加配置按钮）

## 验证

1. `npm run test -w apps/web`、`npm run lint:web`、`npm run build` 全过。
2. `npm run dev` → 回放页字幕面板：未配置时点「生成字幕并优化」走本地（现状）；点齿轮配一个 OpenAI 兼容端点 → 再点主操作走外部、出纠错+章节；故意填错地址 → 自动回退本地、不报致命错。
3. 阅读 GitNexus detect_changes 影响，写入 PR 自检。
4. 不背离 docs/技术方案.md（外部接入属于 `VITE_SUBTITLE_POSTPROCESSOR_MODEL` 之外的运行时可选增强，本地推理与兜底原则不变；token 不进 bundle）。

## 不做（YAGNI）

- 不做后端代理（纯前端 + 风险提示）。
- 不做流式输出、多模型并发、模型自动探测。
- 不改 ASR 链路、不改本地 worker。
- 不持久化多套配置/profile，单套配置即可。
