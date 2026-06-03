# P0 Foundation & Issue Batch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` for tracking. Each Stage is independently committable.

**Goal:** 搭建 `apps/web` 前端基础建设，让组员的"叶子任务" issue 可以并行认领且不会撞到仓库核心代码；同时发放第一批 P0 实施 issue。

**Authority chain:** docs/PRD > docs/技术方案.md（含 §3.5 目录、§4–9 接口签名）> ADR-001..025。本计划不引入新决策。

**Scope split:**

- **维护者直接 commit 到 main**（参照 `规范工作流程.md §五` 维护场景 + 用户授权）：所有"高杠杆 + 易出错"的核心代码 —— schema、validators、调度器、reducer、控制器、运行时控制器、媒体封装、主题系统、UI 原语、工程骨架。
- **叶子任务 issue**（组员认领走 fork+PR+CR）：UI 组件、单个 Producer 实现、e2e 测试、加分项语言扩展、视觉打磨。

**Tech Stack:** Vite 5 + React 18 + TypeScript 5 + TailwindCSS 3 + Radix UI primitives + Monaco Editor 0.50 + lucide-react + Vitest 1 + Playwright 1 + ESLint 9 + Prettier 3 + npm workspaces。

**Font / Aesthetic direction（按 frontend-design + 技术方案 §8.3 收敛）:**

- UI sans: **Geist**（Vercel 出品，工具型应用首选，非 Inter/Roboto）。
- Mono: **JetBrains Mono**（程序员社区辨识度高；Monaco 内编辑器也用同一字体保持观感统一）。
- 色彩空间 OKLCH，深浅主题镜像对齐；深色为默认（ADR-009）。
- 动画克制：仅状态变化 + 焦点环 + 录制脉动；不做营销动画。

---

## File Structure

```text
apps/web/
  package.json, tsconfig.json, tsconfig.node.json
  vite.config.ts, tailwind.config.ts, postcss.config.js, index.html
  eslint.config.js, .prettierrc.json
  playwright.config.ts
  vitest.config.ts
  README.md
  src/
    main.tsx
    app/{App.tsx, routes.tsx}
    features/
      editor/{CodeEditor.tsx (stub), editorState.ts, monacoLanguages.ts}
      recorder/{RecorderPage.tsx, recordingClock.ts, eventBus.ts,
        packageBuilder.ts, recordingController.ts}
      capture/{editorProducer.ts (stub), pointerProducer.ts (stub),
        shortcutProducer.ts (stub), mediaProducer.ts (stub),
        runtimeProducer.ts (stub)}
      media/{mediaDevices.ts, mediaRecorder.ts, CameraPreview.tsx (stub)}
      runtime-preview/{PreviewPane.tsx (stub), iframeRuntime.ts, previewCompiler.ts}
      player/{ReplayPage.tsx, packageLoader.ts, replayIndex.ts,
        replayScheduler.ts, replayReducer.ts, timelineClock.ts,
        mediaClockAdapter.ts, ReplayControls.tsx (stub)}
      library/{RecordingLibraryPage.tsx, recordingStore.ts}
    shared/
      recording-schema/{types.ts, validators.ts, migrations.ts}
      time/{duration.ts}
      ui/{themeProvider.tsx, themeTokens.ts, IconButton.tsx, Toolbar.tsx,
        Slider.tsx, Toggle.tsx, Tooltip.tsx, Popover.tsx}
    styles/{tokens.css, globals.css, fonts.css}
    __tests__/ (vitest, co-located when small)
package.json (root, npm workspaces)
```

文件分类：

- **核心实装** (`recordingClock.ts`, `eventBus.ts`, `packageBuilder.ts`, `recordingController.ts`, `replayScheduler.ts`, `replayReducer.ts`, `replayIndex.ts`, `timelineClock.ts`, `mediaClockAdapter.ts`, `recordingStore.ts`, `iframeRuntime.ts`, `previewCompiler.ts`, `mediaDevices.ts`, `mediaRecorder.ts`, `validators.ts`, `types.ts`, `themeProvider.tsx`, `themeTokens.ts`, UI 原语) —— **本计划直接实装并 commit**。
- **叶子 Stub** (`CodeEditor.tsx`, `CameraPreview.tsx`, `PreviewPane.tsx`, `ReplayControls.tsx`, 5 个 Producer, `RecorderPage.tsx` 内 UI 部分, `RecordingLibraryPage.tsx` 列表 UI) —— 仅放占位 + TODO + 链接到对应 issue，**留给组员 PR**。

---

## Stages

每个 Stage = 一个 commit。每个 Stage 后跑相关测试或编译检查；最终 Stage 12 创建 issues。

### Stage 1 · 工程骨架

- [ ] 根 `package.json` 改为 npm workspaces；保留原 workflow automation 字段
- [ ] `apps/web/{package.json, tsconfig.json, tsconfig.node.json, vite.config.ts, index.html, src/main.tsx, src/app/App.tsx (stub)}` 创建
- [ ] `apps/web/.gitignore` (node_modules, dist, .vite, coverage)
- [ ] 验收：`apps/web` 目录可被 vite 识别（不强制 npm install）

### Stage 2 · 工程治理

- [ ] Tailwind 3 + PostCSS + tokens.css（OKLCH 深浅主题 token）
- [ ] ESLint 9 flat config + Prettier 3
- [ ] Vitest 1（jsdom 环境）+ Testing Library
- [ ] Playwright 1 配置（仅 chromium）
- [ ] `apps/web/styles/{fonts.css}` 引入 Geist + JetBrains Mono（CDN fallback 风险写到 README）
- [ ] 根 `.gitignore` 扩展

### Stage 3 · Recording schema + validators

- [ ] `shared/recording-schema/types.ts`：直接 export 技术方案 §4/§5/§6/§7/§9 全部接口（与文档 1:1）
- [ ] `shared/recording-schema/validators.ts`：`validateRecordingPackageV1`（运行时字段类型校验，不引入 zod 依赖）
- [ ] `shared/recording-schema/migrations.ts`：`migrateRecordingPackage` + migration registry（当前只有 0.1.0 一档）
- [ ] Vitest：合法包通过、各字段缺失/类型错均报对应 path/message、未知 schemaVersion 报 unsupported-schema
- [ ] 验收：`npm test -w apps/web` 全绿

### Stage 4 · 主题系统 + UI 原语 + time util

- [ ] `shared/time/duration.ts`：`formatDurationMs`, `clampMs`
- [ ] `shared/ui/themeTokens.ts`：与 `tokens.css` 同步的常量表
- [ ] `shared/ui/themeProvider.tsx`：`ThemeContext`, `useTheme`, `localStorage` 持久化，监听 `prefers-color-scheme`
- [ ] `IconButton`, `Toolbar`, `Slider`, `Toggle`, `Tooltip`, `Popover`（基于 Radix）
- [ ] Vitest：theme 切换持久化、tokens 表完整

### Stage 5 · Recorder core engines

- [ ] `features/recorder/recordingClock.ts`：实装 §5.2 接口（含 `subscribe`）
- [ ] `features/recorder/eventBus.ts`：实装 §5.3 接口（`seq` 单调、`timestampMs` 从 clock 取）
- [ ] `features/recorder/packageBuilder.ts`：实装 §5.1 接口（事件去重、checksum 计算）
- [ ] `features/recorder/recordingController.ts`：实装 §5.1 状态机
- [ ] Vitest 全部覆盖：clock 暂停不累积、bus seq 单调、controller 状态迁移合法

### Stage 6 · Player core engines

- [ ] `features/player/replayReducer.ts`：纯函数 reducer，覆盖所有稳定状态事件
- [ ] `features/player/replayIndex.ts`：从 package 构建索引
- [ ] `features/player/timelineClock.ts` + `mediaClockAdapter.ts`
- [ ] `features/player/replayScheduler.ts`：实装 §7.3 接口（含 seek 算法）
- [ ] `features/player/packageLoader.ts`：实装 §4.8 PackageLoader
- [ ] **关键不变量测试**：构造 N 个事件流，验证"从头播到 t" 与 "从最近 snapshot seek 到 t" 得到的 `ReplayStableState` deep-equal

### Stage 7 · Storage (IndexedDB)

- [ ] `features/library/recordingStore.ts`：实装 §9.1 RecordingRepository（两阶段提交、sweep、quota、zip 导入导出）
- [ ] 使用原生 IndexedDB API（不引入 dexie 等依赖，保持依赖最小）
- [ ] Vitest（jsdom 下使用 fake-indexeddb）覆盖 saveDraft → commit → load 闭环

### Stage 8 · Runtime preview

- [ ] `features/runtime-preview/previewCompiler.ts`：JS 直通；TS 通过 `import('typescript')` 懒加载 transpile
- [ ] `features/runtime-preview/iframeRuntime.ts`：实装 §6.2 IframeRuntime；`acceptRuntimeMessage` 严格校验
- [ ] Vitest：runtime message 校验（伪造 source/runId 被拒绝）；compile 错误编码正确

### Stage 9 · Media

- [ ] `features/media/mediaDevices.ts`：实装 §5.8 MediaDevicesController
- [ ] `features/media/mediaRecorder.ts`：实装 §5.8 MediaRecorderWrapper
- [ ] 浏览器 API 在 jsdom 下大多 mock，Vitest 仅做接口契约 + 错误编码测试

### Stage 10 · App shell + routes

- [ ] `app/App.tsx`, `app/routes.tsx`（React Router 6）
- [ ] `RecorderPage.tsx`：装配 RecordingController + 各 Producer（Producer 此时仍是 stub，不阻塞编译）
- [ ] `ReplayPage.tsx`：装配 ReplayScheduler + 渲染层
- [ ] `RecordingLibraryPage.tsx`：装配 RecordingRepository + 列表骨架
- [ ] 三页都用 `Toolbar` 布局；首屏可访问，不报错

### Stage 11 · Docs

- [ ] 根 `README.md`：补 quickstart（`npm install` + `npm run dev` + `npm test`）
- [ ] `apps/web/README.md`：目录说明、核心模块表、新人贡献指南、链接到 issue 列表
- [ ] `CLAUDE.md` / `AGENTS.md` 追加一行"开发命令在 apps/web/README.md"

### Stage 12 · Issues

按依赖顺序批量 `gh issue create`，每个 issue：

- 标题：`[P0] <module> <task>` / `[加分项] ...`
- body 引用：技术方案 §X.Y + ADR-### + 接口签名片段
- labels：`score:N`, `stack:react`/`stack:typescript`/`stack:github-actions`, `status:open`
- 验收 checklist
- 闭环条款：PR 中 `Closes #<n>`

**第一批 issue（无前置依赖 / 仅依赖 Stage 1-10 已 commit 的核心）：**

1. `[P0] CodeEditor 组件接入 Monaco`（score:5, stack:react）
2. `[P0] editorProducer 实装`（score:3, stack:typescript）
3. `[P0] pointerProducer 实装`（score:2, stack:typescript）
4. `[P0] shortcutProducer 实装 + Badge label 映射`（score:3, stack:typescript）
5. `[P0] mediaProducer 实装 + CameraPreview 拖拽`（score:5, stack:react）
6. `[P0] runtimeProducer 实装`（score:2, stack:typescript）
7. `[P0] RecorderPage 录制控制条 UI`（score:3, stack:react）
8. `[P0] RecordingLibraryPage 列表 UI`（score:3, stack:react）
9. `[P0] ReplayControls 控制条 UI（含倍速/音量/进度条）`（score:5, stack:react）
10. `[P0] 鼠标激光笔 + 快捷键 Badge 渲染层`（score:3, stack:react）
11. `[P0] PreviewPane 渲染 IframeRuntime 输出`（score:2, stack:react）
12. `[P0] e2e: 录制 → 保存 → 回放 → seek 闭环（Playwright）`（score:5, stack:typescript）
13. `[加分项] Python 语言切换、高亮、录制语言状态回放恢复`（score:3, stack:typescript）

第二批留到 Stage 12 commit 后视占用情况追加：UI 视觉打磨、AI 字幕 PoC、WebRTC 最小同步等。

---

## Verification

- 每个 Stage commit 前跑该 Stage 涉及的 vitest 文件。
- Stage 11 后跑一次 `npm install` 验证 lockfile（如时间允许）。
- Stage 12 后 `gh issue list` 应显示新创建的 13 个 issue 都是 `status:open`。

## Anti-goals

- 不实装 5 个 Producer 的具体逻辑（留给组员）。
- 不实装 RecorderPage / ReplayPage 的具体 UI 渲染（除骨架布局外）。
- 不引入 zustand / redux / dexie / zod 等额外依赖（保持依赖最小）。
- 不写营销动画、不写 landing page、不写 onboarding 引导。
