# StackBlitz 与 WebContainers 浏览器沙箱调研

调研日期：2026-05-22

## 一、结论摘要

StackBlitz 是浏览器内代码编辑、运行、预览和分享平台。它背后有两类运行环境：传统前端模板使用的 EngineBlock，以及支持浏览器内 Node.js / npm / 终端 / dev server 的 WebContainers。WebContainers 的能力很接近“把轻量 Node 开发环境搬进浏览器标签页”，适合交互式文档、教学、在线 IDE 和 AI coding 场景。

对本项目来说，WebContainers 是 P1 甚至 P1+ 的好方向，但不建议作为 P0 主路线。原因是 P0 的核心风险已经集中在录制、事件流、音视频同步、回放调度和 seek 状态恢复；如果同时引入 WebContainers，还要处理 COOP/COEP、浏览器兼容、Service Worker、npm 安装耗时、资源占用和项目文件系统同步，容易把一个月 Demo 的重心拖偏。

推荐 P0 采用“iframe sandbox 前端展示 + 可选 console 捕获”的路线：先支持 HTML/CSS/JS 或 JS/TS 编译后的页面预览，确保录制与回放主链路可演示；P1 再用 WebContainers 做 Node/npm 项目运行 PoC；后端沙箱作为需要强资源隔离、多语言执行或服务端判题时的专项能力。

## 二、官方资料

### StackBlitz 官方资料

- StackBlitz 首页：https://stackblitz.com/
- StackBlitz Docs - Getting started：https://developer.stackblitz.com/guides/user-guide/getting-started
- StackBlitz Docs - Available environments：https://developer.stackblitz.com/guides/user-guide/available-environments
- StackBlitz Docs - Embedding projects：https://developer.stackblitz.com/guides/integration/embedding
- StackBlitz Docs - Creating projects with the SDK：https://developer.stackblitz.com/guides/integration/create-with-sdk
- StackBlitz Docs - Controlling embeds with the SDK VM：https://developer.stackblitz.com/platform/api/javascript-sdk-vm
- StackBlitz Docs - WebContainers browser support：https://developer.stackblitz.com/platform/webcontainers/browser-support
- StackBlitz Docs - Importing projects：https://developer.stackblitz.com/guides/user-guide/importing-projects

### WebContainers 官方资料

- WebContainers Introduction：https://webcontainers.io/guides/introduction
- WebContainers API Reference：https://webcontainers.io/api
- WebContainers Quickstart：https://webcontainers.io/guides/quickstart
- Working with the File System：https://webcontainers.io/guides/working-with-the-file-system.html
- Running Processes：https://webcontainers.io/guides/running-processes
- Configuring Headers：https://webcontainers.io/guides/configuring-headers
- Browser Support：https://webcontainers.io/guides/browser-support
- Browser Configuration：https://webcontainers.io/guides/browser-config
- Troubleshooting：https://webcontainers.io/guides/troubleshooting

## 三、产品和技术定位

### StackBlitz 定位

StackBlitz 面向代码示例、在线 IDE、文档示例、bug 复现和教学场景。它允许用户从 starter、GitHub 仓库或 SDK 动态创建项目，在浏览器内编辑文件、运行项目、查看 preview，并把项目嵌入文档或网页。

对 code-tape 有参考价值的是两点：

- 它把编辑器、项目文件、运行结果、终端和预览放在同一个工作台里。
- 它支持 iframe embed 和 SDK 控制，适合研究“代码讲解工具如何嵌入运行/展示区”。

### WebContainers 定位

WebContainers 是 StackBlitz 开发的浏览器内运行时，用于在浏览器标签页里执行 Node.js 应用和操作系统命令。官方文档把典型场景定位在 interactive coding experiences、浏览器内代码执行、编程教程、下一代文档、浏览器 IDE 和员工 onboarding。

它和普通 iframe preview 的区别很大：iframe preview 更像“把一段前端页面放进隔离窗口展示”，WebContainers 则更像“在浏览器中启动一个带文件系统、进程、npm 和 dev server 的项目运行环境”。

## 四、WebContainers 能力清单

| 能力 | 官方资料依据 | 对 code-tape 的价值 |
| --- | --- | --- |
| 浏览器内 Node.js 运行时 | WebContainers Introduction 说明其可在浏览器标签页内运行 Node.js 应用和命令 | 可支持更接近真实前端项目的代码运行 |
| npm / pnpm / yarn 生态 | StackBlitz Available environments 说明 WebContainers 支持主流包管理器；Running Processes 展示 `npm install` | 可运行依赖 Vite、Webpack 等工具链的示例 |
| 终端和命令执行 | Running Processes 通过 `spawn(command, args)` 执行命令，并提供输出流 | 可在教学中展示安装、启动、构建等命令输出 |
| 虚拟文件系统 | Working with the File System 和 API Reference 提供 `mount`、`fs.readFile`、`writeFile`、`readdir` 等能力 | 可把录制包中的项目文件映射为运行环境文件 |
| 多文件项目 | SDK 创建项目和 WebContainer `FileSystemTree` 都支持多文件/目录结构 | 适合 P1 从单文件讲解扩展到项目级讲解 |
| dev server / preview | API 和 Running Processes 提供 `server-ready`、`port` 等事件 | 可启动 Vite/Express 等服务并在 preview 中展示 |
| iframe 嵌入 | StackBlitz Embedding projects 支持 iframe embed 和 URL 参数配置 | 可借鉴 P0 预览区/嵌入区的产品形态 |
| SDK 控制 embed | StackBlitz VM interface 可控制 UI、打开文件、读写虚拟文件系统、获取文件快照 | 可用于未来从 code-tape 同步代码到嵌入环境 |
| 错误转发 | WebContainers API 支持 `preview-message` 事件转发 console error、unhandled rejection、uncaught error | 可作为 P1 console / error 面板参考 |
| 客户端计算 | WebContainers Introduction 强调运行在客户端，降低云 VM 成本并减少服务端执行恶意代码风险 | 对训练营 Demo 有吸引力，但仍有前端资源和兼容性成本 |

## 五、WebContainers 限制清单

| 限制 | 影响 | 对本项目的含义 |
| --- | --- | --- |
| 需要现代浏览器能力 | 官方 Browser Support 说明 WebContainers 依赖 SharedArrayBuffer 和 cross-origin isolation | 部署环境必须配置正确 headers，不能假设所有浏览器开箱即用 |
| 需要 COOP / COEP | Configuring Headers 要求页面设置 `Cross-Origin-Embedder-Policy` 和 `Cross-Origin-Opener-Policy` | P0 如果只是静态部署或训练营现场演示，额外部署配置会增加风险 |
| Chromium 支持最好 | 官方说明 Chrome/Chromium 支持最好，Firefox/Safari 仍有 beta/alpha 或限制 | 若面向普通学习者，浏览器兼容性说明和 fallback 必不可少 |
| 受浏览器/插件策略影响 | Browser Support 和 Browser Configuration 提到第三方 cookie、浏览器内置拦截、Service Worker 等会影响运行 | 用户环境问题会变成产品支持成本 |
| 移动端资源受限 | StackBlitz Browser Support 提到移动端大项目可能遇到内存限制 | P0 不应承诺移动端完整项目运行 |
| 不是完整后端环境 | StackBlitz Importing projects 说明不支持 PHP/Python/Java、数据库服务等非 Node 或二进制服务 | WebContainers 不能替代所有后端沙箱 |
| 部分 npm 包不兼容 | 官方导入文档提到某些 npm 包与 WebContainers 不完全兼容 | 不能保证任意用户项目都能跑 |
| 启动与依赖安装仍有成本 | npm install、dev server 启动会消耗客户端 CPU/内存和等待时间 | 会影响录制/回放主流程的稳定体验 |
| 与录制回放同步复杂 | 文件系统、进程、终端输出、preview URL 都有独立状态 | 若进入 P0，事件模型会显著膨胀 |
| 商业/API 使用边界需确认 | WebContainers API Reference 提到商业使用 API key / enterprise 信息 | 若未来产品化，需要单独确认许可和费用 |

## 六、安全与隔离边界

### WebContainers 的安全收益

WebContainers 最大的安全收益是把代码执行放在浏览器标签页内，减少云端 VM 被挖矿、恶意脚本、钓鱼站点滥用的风险。对平台方而言，用户代码主要消耗用户本机浏览器资源，而不是服务端资源。

### 仍需处理的边界

这不等于“没有安全问题”。本项目如果接入 WebContainers，仍需处理：

- 预览页面和宿主应用之间的隔离，避免用户代码影响录制器 UI。
- COOP/COEP 导致的跨源资源加载限制。
- Service Worker 域名、缓存和清理策略。
- 用户代码的 CPU、内存、死循环和卡顿问题。
- 终端命令输出、错误信息和隐私信息是否进入录制包。
- 第三方依赖安装、私有 npm 包认证和网络访问边界。

### iframe sandbox 的安全边界

iframe sandbox 更轻，但能力也更窄。它适合展示 HTML/CSS/JS 页面，并通过 `sandbox` 属性限制脚本、表单、弹窗、同源访问等能力。它不提供 Node.js、npm、真实终端和 dev server，但足够支持 P0 的“代码执行/展示沙箱”演示。

### 后端沙箱的安全边界

后端沙箱可控性最强，可以做进程隔离、容器隔离、资源限额、网络限流和审计，但实现成本最高。它把安全压力从浏览器转移到服务器，P0 如果没有明确多语言执行或判题需求，不建议承担这个复杂度。

## 七、三种路线对比

| 路线 | 能力范围 | 实现成本 | 安全风险 | 浏览器兼容性 | 训练营可交付性 | 适合阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| iframe 前端展示 | HTML/CSS/JS 预览、可选 console 捕获、简单错误展示 | 低到中 | 主要控制宿主隔离和弹窗/同源权限 | 高，现代浏览器均可支持基础 iframe | 高，最容易在 P0 跑通 | P0 推荐 |
| 前端沙箱 / WebContainers | Node.js、npm、终端、文件系统、dev server、复杂前端项目 | 中到高 | 服务端风险低，但客户端资源、依赖和跨源策略复杂 | 中，Chromium 最稳，Safari/Firefox/移动端需谨慎 | 中低，容易拖累主链路 | P1 PoC / P1+ |
| 后端沙箱 | JS/TS 或多语言执行、stdout/stderr、资源限制、可统一环境 | 高 | 平台方承担恶意代码、资源耗尽和隔离风险 | 高，浏览器只需调用接口 | 中低，需要后端隔离能力 | P1 或专项 |

## 八、对 P0 代码执行/展示路线的建议

### 推荐方案：P0 采用 iframe sandbox 前端展示

P0 的目标是可用 Demo，核心要证明“代码讲解录制和回放”成立，而不是证明“浏览器内完整 IDE”成立。建议 P0 做：

1. 编辑器支持 JS/TS 或 HTML/CSS/JS 基础编辑。
2. 运行按钮把当前代码生成预览 HTML。
3. 使用 sandboxed iframe 渲染预览结果。
4. 拦截并展示 `console.log`、`console.error` 和运行错误，若时间不足则只展示错误。
5. 将运行动作和输出写入录制事件，例如 `run-start`、`run-output`、`run-error`。
6. 回放时优先还原运行结果快照，不在回放过程中重新执行不可信代码。

这个方案最贴合现有技术拆解中的“前端代码页面展示”方向，也最不容易干扰录制、音视频和回放调度。

### P1 可评估 WebContainers

WebContainers 适合作为 P1 的技术增强：

- 支持 Vite / React / Vue / Node starter 项目。
- 支持 npm install、终端输出和 dev server preview。
- 支持多文件项目运行和 SDK 文件同步。
- 支持更接近真实前端工程的教学/面试题。

建议进入 P1 前先做一个 1-2 天 PoC，只验证四件事：

1. 当前部署环境能否稳定配置 COOP/COEP。
2. Chrome / Edge / Safari / Firefox 的最低可用体验。
3. npm install + dev server 启动时间是否可接受。
4. WebContainer 状态如何与录制事件和回放快照对齐。

### 后端沙箱暂不进入 P0

后端沙箱只有在以下需求明确时才值得提前：

- 必须执行服务端 Node、Python、Java 等非纯前端代码。
- 必须做资源限额、判题或统一运行环境。
- 必须在弱浏览器或移动端保持一致执行能力。
- 必须避免客户端暴露运行逻辑。

当前 code-tape 的 P0 主目标是代码讲解录制与回放，后端沙箱会把安全和运维复杂度显著拉高，不建议作为首选。

## 九、对事件流和录制包的影响

P0 即使采用 iframe sandbox，也应该为未来 WebContainers 预留最小扩展点：

```json
{
  "type": "run-output",
  "timestamp": 34567,
  "payload": {
    "runtime": "iframe",
    "command": "preview",
    "status": "success",
    "stdout": ["hello"],
    "stderr": [],
    "previewSnapshot": "<html>...</html>"
  }
}
```

未来如果升级到 WebContainers，可把 `runtime` 扩展为 `webcontainer`，并增加：

- `filesSnapshot`：运行时文件快照。
- `command`：例如 `npm install`、`npm run dev`。
- `terminalOutput`：终端输出流片段。
- `serverUrl`：dev server ready 后的预览 URL。
- `exitCode`：命令退出码。

关键原则是：回放不应默认重新执行用户代码。录制时可以保存运行输出和预览快照；回放时先展示当时结果，只有用户主动“重新运行”时才进入真实执行环境。这样能降低 seek 和回放一致性的风险。

## 十、P0 / P1 取舍清单

### P0 应做

- iframe sandbox 预览。
- 基础 console / error 捕获，视时间取舍。
- 运行事件进入录制事件流。
- 回放时还原运行结果，而不是强制重跑。
- 为多文件、运行时类型、输出流预留字段。

### P0 不应做

- WebContainers 全量接入。
- npm install / dev server / 终端录制。
- 任意用户项目导入运行。
- 移动端完整运行承诺。
- 后端容器沙箱、资源限额和多语言执行。

### P1 可做

- WebContainers PoC。
- 多文件项目运行。
- 终端输出面板。
- dev server preview。
- 录制包与 WebContainer 文件系统同步。
- 更完整的 console / error / network 展示。

## 十一、验收标准映射

| Issue 验收项 | 本文对应位置 |
| --- | --- |
| 至少引用 StackBlitz 和 WebContainers 官方资料链接 | “二、官方资料” |
| 输出 WebContainers 能力清单和限制清单 | “四、WebContainers 能力清单”“五、WebContainers 限制清单” |
| 对比前端沙箱、iframe 展示、后端沙箱三种路线 | “七、三种路线对比” |
| 给出本项目 P0 代码执行/展示路线建议 | “八、对 P0 代码执行/展示路线的建议”“十、P0 / P1 取舍清单” |
