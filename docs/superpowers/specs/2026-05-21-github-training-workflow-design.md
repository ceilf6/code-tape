# GitHub 训练营协作流程设计

## 目标

为前端组训练营建立一套基于 GitHub 的标准协作流程：组长从 PRD 拆分任务 Issue，同学通过评论认领任务，从 fork 或维护者分支提 PR，经过至少一名非作者同学 CR 后自动合并，并由 GitHub Actions 维护任务进度与积分台账。

这套流程优先满足以下约束：

- 普通同学不能修改主仓库 label。
- 普通同学不能直接修改进度/积分台账文件。
- 一位同学同一时间只能认领一个未完成任务。
- PR 需要关联 Issue，合并后关闭 Issue。
- PR 在 24 小时内未达到可合并状态时自动关闭，但不释放任务。
- 任务分数、开发得分、CR 得分、bug 扣分都可追溯。

## 角色与权限

### 组长/维护者

- 拥有主仓库管理权限。
- 负责从 PRD 拆分 Issue。
- 负责创建和设置任务 label。
- 可以在主仓库开 feature 分支提 PR，也可以参与计分。
- 属于可信角色；技术上 GitHub owner/admin 无法被完全禁止修改 label 或受保护文件。

### 普通同学

- 主仓库只授予 `read` 权限。
- 可以查看仓库、打开 Issue、评论 Issue、从 fork 提 PR、提交 PR review。
- 不能修改主仓库 label。
- 不能直接 push 主仓库分支。
- 不能手动修改 `docs/progress.json` 和 `docs/progress.md`。

GitHub 官方权限表显示：`read` 权限可以 open issues、从 fork 提 PR、submit reviews，但不能 apply/dismiss labels；`triage` 可以 apply/dismiss labels，`write` 可以 create/edit/delete labels。因此，为了确保同学无法修改 label，普通同学不应授予 `triage` 或 `write` 权限。

参考：

- [Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
- [Managing labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)

### GitHub Actions

- 唯一负责自动维护任务状态与台账。
- 负责处理认领评论。
- 负责检查 PR 与 Issue 的关联关系。
- 负责判断 CR 是否有效。
- 负责自动 squash merge 已满足条件的 PR。
- 负责关闭超时 PR，但保留 Issue 的认领状态。
- 负责在合并后更新 `docs/progress.json` 与 `docs/progress.md`。

## Issue 与 Label 规范

### Label 范围

仓库只需要三类任务 label：

- `score:*`：任务分数，例如 `score:1`、`score:2`、`score:3`、`score:5`、`score:8`。
- `stack:*`：所需技术栈，例如 `stack:react`、`stack:typescript`、`stack:github-actions`、`stack:research`。
- `status:*`：认领状态，只使用 `status:open` 和 `status:claimed`。

不使用 `type:*`、`priority:*`、`assignee:*` 等 label，避免 label 体系膨胀。负责人记录使用 GitHub assignee 和 `docs/progress.json`。

### PRD 拆解入口 Issue

组长创建一个总控 Issue，例如：

```text
PRD 拆解：代码讲解工具
```

该 Issue 用于持续记录 PRD 拆解过程，正文包含：

- PRD 链接或仓库内 PRD Markdown 路径。
- 当前拆解阶段。
- 已拆出的任务 Issue 列表。
- 后续待拆功能点。

后续每拆出一个可独立完成、可独立验收的功能点，就新建一个普通任务 Issue。

当前阶段可以优先拆出信息收集类 Issue，例如：

- 调研代码编辑器选型。
- 调研操作事件录制模型。
- 调研音视频录制 API。
- 调研前端沙箱执行方案。
- 调研 GitHub Actions 计分流程。

信息收集类 Issue 与实现类 Issue 使用同一套认领、PR、CR、计分规则。

### 普通任务 Issue 格式

标题建议：

```text
[前端] 录制控制栏
```

正文必须包含：

- 背景/目标。
- 验收标准。
- 技术栈要求。
- 关联 PRD 章节。
- 分数说明。

创建后由组长设置：

- 一个且仅一个 `score:*` label。
- 一个或多个 `stack:*` label。
- 初始状态 `status:open`。

## 认领规则

同学在 Issue 下评论精确关键词：

```text
认领
```

认领 workflow 检查：

- 评论者不是 bot。
- Issue 带有 `status:open`。
- Issue 有且仅有一个 `score:*` label。
- 评论者当前没有其他 active Issue。
- Issue 尚未被其他同学认领。

认领成功后 workflow：

- 移除 `status:open`。
- 添加 `status:claimed`。
- 将评论者设置为 GitHub assignee。
- 更新 `docs/progress.json` 中该同学的 active Issue。
- 重新生成 `docs/progress.md`。
- 在 Issue 下评论开发提示，包括分支命名、PR 关联方式、24 小时限制。

认领失败时 workflow 在 Issue 下评论失败原因，例如：

- 已有任务未完成。
- Issue 不可认领。
- Issue 缺少分数 label。
- Issue 已被他人认领。

## 开发与 PR 规则

### 开发方式

普通同学：

- fork 主仓库。
- 在自己的 fork 中基于 `main` 切 feature 分支。
- 开发完成后向主仓库 `main` 提 PR。

组长/维护者：

- 可以在主仓库切 feature 分支开发。
- 日常开发建议仍然提 PR、关联 Issue 并经过 CR，保证计分和流程一致。
- 保留仓库管理员直接 push / bypass 权限，用于流程修复、紧急配置调整等维护场景。

### PR 要求

PR 标题建议：

```text
#[issue-number] 简短说明
```

PR 正文必须包含：

```text
Closes #[issue-number]
```

PR workflow 检查：

- PR 必须关联一个 Issue。
- 关联 Issue 必须是 `status:claimed`。
- PR author 必须是该 Issue 的认领者。
- PR 不能修改受保护台账文件：
  - `docs/progress.json`
  - `docs/progress.md`
- PR 必须在创建后 24 小时内达到可自动合并状态。

### CR 规则

至少需要一名非 PR author 的同学完成有效 CR。

有效 CR 定义：

- reviewer 不是 PR author。
- reviewer 是 GitHub 用户，不是 bot。
- reviewer 不是 `github-actions[bot]`。
- reviewer 是 PR conversation 中第一个有效评论者。
- reviewer 本人在最新 commit 后评论精确通过信号。

由于普通同学只有 `read` 权限，不能依赖 GitHub 分支保护里的 required approving reviews 作为唯一判断。CR 是否有效由 workflow 判定：PR conversation 中第一个有效评论者自动认领 CR，只有该 reviewer 本人在 PR 下评论精确关键词才算通过：

```text
CR通过
```

分支保护不直接要求 GitHub 原生 required approving reviews，而是要求工作流检查通过。CR 检查通过后，workflow 作为自动化执行者合并 PR。

### 自动合并

当 PR 同时满足以下条件：

- 已关联认领中的 Issue。
- PR author 是认领者。
- 至少一名有效 CR。
- 基础检查通过。
- 未修改受保护台账文件。
- 未超过 24 小时。

workflow 自动执行 squash merge。

合并后 workflow：

- 关闭关联 Issue。
- 将 Issue 的 `status:claimed` 移除。
- 清空该同学 active Issue。
- 按计分规则写入 `docs/progress.json`。
- 重新生成 `docs/progress.md`。

### 24 小时 PR 关闭

PR 创建后开始计时。

如果 24 小时内没有达到可自动合并状态，定时 workflow：

- 评论说明超时原因。
- 关闭 PR。
- 保留关联 Issue 的 `status:claimed`。
- 保留 GitHub assignee。
- 保留认领者在 `docs/progress.json` 中的 active Issue。
- 如果 PR 分支在主仓库且不是 `main`，删除该分支。

超时关闭 PR 不代表任务释放。认领者仍然负责该 Issue，可以继续在同一任务下重新提 PR；新 PR 重新开始 24 小时计时。

对于 fork 分支，主仓库无法强制删除，只关闭 PR，并继续保留任务认领状态。

## 进度与积分台账

不单独维护 `scoreboard` 文件。仓库只保留一组进度台账文件：

- `docs/progress.json`：机器可读，workflow 写入。
- `docs/progress.md`：人类可读，workflow 从 JSON 生成。

普通 PR 修改这两个文件时，检查必须失败。只有台账 workflow 可以更新它们。

### progress.json 建议结构

```json
{
  "students": {
    "github-username": {
      "activeIssue": null,
      "completedIssues": [],
      "reviewedIssues": [],
      "bugPenalties": [],
      "developmentScore": 0,
      "reviewScore": 0,
      "penaltyScore": 0,
      "totalScore": 0
    }
  },
  "ledger": []
}
```

`ledger` 保留每一条积分流水，用于查账和追溯。`docs/progress.md` 展示聚合后的进度表、总分表和最近流水。

### 正常任务计分

Issue 必须有一个 `score:N` label。

PR 合并后：

- 开发者获得 `N * 75%`。
- 有效 CR 同学获得 `N * 25%`。

如果多人参与 CR，默认取首个有效 PR 评论者作为计分 reviewer。

## Bug 返工规则

任意同学发现已合并任务存在 bug 后，新建 bug Issue。

bug Issue 正文必须包含：

- 关联原 Issue。
- 关联原 PR。
- bug 现象。
- 复现步骤。
- 期望行为。

bug Issue 也必须设置：

- 一个且仅一个 `score:N` label，分数与原任务一致。
- 一个或多个 `stack:*` label。
- `status:open`。

bug Issue 也必须先评论 `认领`，并遵守“一位同学同一时间只能有一个 active Issue”的规则。

bug 修复 PR 合并后：

- 原开发者扣 `N * 150%`。
- 原 CR 同学扣 `N * 50%`。
- 修复开发者获得 `N * 75%`。
- 修复 CR 同学获得 `N * 25%`。

如果同一个原任务被多次发现 bug，每个有效 bug 修复都独立触发一次扣分和修复奖励。

## 受保护文件与主分支保护

### 受保护文件

以下文件只能由 workflow 更新：

- `docs/progress.json`
- `docs/progress.md`

保护方式：

- PR 检查检测 diff，如果普通 PR 修改这些文件则失败。
- `CODEOWNERS` 将这些文件归属给维护者。
- `main` 禁止普通同学直接 push，组长/仓库管理员保留 bypass 权限。
- workflow 使用受控 token 更新文件。

### 主分支保护

`main` 分支建议启用：

- 禁止普通同学直接 push。
- 不勾选 “Do not allow bypassing the above settings”，组长/仓库管理员保留直接 push / bypass 权限。
- 必须通过 PR 合并。
- 必须通过工作流检查。
- 使用 squash merge。
- 自动删除已合并主仓库分支。

不建议依赖 GitHub 原生 required approving reviews 作为唯一 CR 门禁，因为普通同学为避免 label 权限只能授予 `read` 权限，而该权限在 required review 场景下不适合作为强制 approval 来源。CR 门禁由 workflow 自己执行。

## 工作流模块

建议拆分为以下 GitHub Actions：

- `issue-claim.yml`：监听 Issue 评论 `认领`，处理认领与进度更新。
- `pr-guard.yml`：监听 PR opened/synchronize/reopened/edited/review/submitted/comment，检查关联 Issue、作者、CR、受保护文件。
- `pr-auto-merge.yml`：当 `pr-guard` 通过且 CR 有效时 squash merge PR。
- `pr-timeout-cleanup.yml`：定时扫描超过 24 小时未合并 PR，关闭 PR，但不释放 Issue。
- `progress-maintenance.yml`：合并后统一更新 `docs/progress.json` 和 `docs/progress.md`。
- `bug-ledger.yml`：识别 bug Issue 关联的原 Issue/PR，合并修复后写入扣分与修复奖励。

实际实现时可以先合并部分 workflow，等逻辑稳定后再拆分。

## 风险与取舍

- 普通同学只有 `read` 权限，因此不能通过主仓库分支开发，必须 fork PR。
- GitHub owner/admin 无法被技术手段完全禁止修改 label 或台账文件，需要作为可信维护者处理。
- CR 门禁由 workflow 判断，而不是 GitHub 原生 required approving reviews；这样能同时满足“同学不能改 label”和“同学可以参与 CR”。
- fork 分支无法由主仓库自动删除，24 小时清理只能关闭 PR，并继续保留 Issue 认领状态。
- 计分使用小数时需要统一保留规则，建议 `score` 使用整数，结果保留两位小数。

## 待实现清单

- 创建 label 初始化脚本。
- 创建 Issue 模板。
- 创建 PR 模板。
- 创建 `docs/progress.json` 初始文件。
- 创建 `docs/progress.md` 初始文件。
- 创建受保护文件检查 workflow。
- 创建认领 workflow。
- 创建 PR guard workflow。
- 创建自动 squash merge workflow。
- 创建 24 小时清理 workflow。
- 创建进度台账维护脚本。
- 配置主分支保护规则和仓库权限。
