# PR CR 自动认领设计

## 背景

当前训练营 workflow 通过 PR review 的 `APPROVED` 状态或 PR conversation 中精确的 `CR通过` 评论判定 CR 通过，并取最早有效通过信号的同学计分。这会产生一个漏洞：A 已经在 PR 下提出问题时，B 仍可直接评论 `CR通过`，导致 PR 被 workflow 自动合入并给 B 计分。

本设计不改变 `docs/PRD/代码讲解工具.md` 和 `docs/技术方案.md` 中产品主链路，仅收敛训练营 GitHub workflow 的 CR 判定规则。

## 目标

- PR 被首个有效 PR conversation 评论者自动认领 CR。
- 只有认领者本人评论精确 `CR通过` 后，PR 才算 CR 通过。
- `github-actions[bot]`、其他 Bot 和 PR 作者不能认领 CR。
- repo-guard 自动评论不能抢占 CR 认领。
- PR 在认领后继续 push 时，认领者保持不变，但必须重新评论 `CR通过`。

## 非目标

- 不新增 `认领CR`、`CR认领` 等显式认领关键词。
- 不再把 GitHub `APPROVED` review 作为单独通过信号。
- 不改变 Issue 认领、24 小时超时、受保护文件、自动合并和计分台账的其他规则。

## 规则

1. 按评论时间升序扫描 PR conversation comments。
2. 首个满足以下条件的评论者成为 CR reviewer：
   - `comment.user.login` 存在。
   - 评论者不是 PR author。
   - `comment.user.type !== "Bot"`。
   - 评论者不是 `github-actions[bot]`。
3. 有 CR reviewer 后，只接受该 reviewer 本人精确评论 `CR通过`。
4. `CR通过` 评论时间必须晚于或等于 PR 最新 commit 时间。
5. 若没有 reviewer 或 reviewer 尚未在最新 commit 后评论 `CR通过`，guard 失败。

## 影响范围

- `scripts/workflows/pr-parser.mjs`：新增 reviewer 认领解析，并修改有效 CR 判定。
- `scripts/workflows/guard-pr.mjs`：继续通过 `findValidReviewer` 获取 reviewer，不改变外部返回结构。
- `scripts/workflows/apply-merge-score.mjs`：继续复用 `findValidReviewer`，计分 reviewer 自动变为认领者。
- `scripts/tests/workflow-rules.test.mjs`：补充自动认领、Bot 排除、push 后重新 CR 的单测。

## 测试策略

- A 首先评论问题，B 评论 `CR通过`，`findValidReviewer` 返回 `null`。
- A 首先评论问题，A 在最新 commit 后评论 `CR通过`，返回 `A`。
- `github-actions[bot]` 先评论后，A 评论问题并通过，返回 `A`。
- PR 作者先评论不认领，A 评论并通过，返回 `A`。
- A 在旧 commit 后评论 `CR通过`，PR push 后 B 评论 `CR通过`，返回 `null`；A 重新评论后返回 `A`。
