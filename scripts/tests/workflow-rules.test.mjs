import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  hasStatus,
  parseBugReferences,
  parseScore,
  parseStack,
} from '../workflows/issue-parser.mjs';
import {
  findValidReviewer,
  parseClosingIssues,
} from '../workflows/pr-parser.mjs';
import { shouldWaitForMergeableState } from '../workflows/mergeable-state.mjs';
import {
  pullNumberFromEvent,
  resolvePullNumberFromEvent,
} from '../workflows/action-context.mjs';
import {
  findMaintainerMergeConfirmation,
  shouldDeferAutoMergeForForkReview,
  shouldWaitForRequiredChecks,
} from '../workflows/auto-merge-rules.mjs';
import {
  applyBugFixMerge,
  applyFeatureMerge,
  claimIssue,
  createEmptyProgress,
} from '../workflows/progress-store.mjs';
import { renderProgressMarkdown } from '../workflows/render-progress.mjs';
import { evaluatePrGuard } from '../workflows/guard-pr.mjs';
import {
  CONTRACT_DIFF_FILTER,
  classifyContractPaths,
  combineChangedFiles,
  evaluateGitNexusContract,
  extractImpactSummary,
} from '../workflows/contract-rules.mjs';

const standaloneCloudPlanPath = () => ['docs', '云端技术方案.md'].join('/');

const validGitNexusSummary = [
  '- 风险等级: HIGH',
  '- 关键骨架变更: apps/web/src/shared/recording-schema/validators.ts',
  '- GitNexus 影响面: detect_changes and context confirmed schema validators affect loader tests only.',
  '- 验证结果: npm test passed',
].join('\n');

test('parseScore requires exactly one score label', () => {
  assert.equal(parseScore(['score:5', 'stack:react', 'status:open']), 5);
  assert.throws(() => parseScore(['stack:react']), /exactly one score/);
  assert.throws(() => parseScore(['score:3', 'score:5']), /exactly one score/);
  assert.throws(() => parseScore(['score:abc']), /invalid score/);
});

test('parseStack extracts stack labels without non-stack labels', () => {
  assert.deepEqual(parseStack(['score:5', 'stack:react', 'stack:typescript', 'status:open']), [
    'react',
    'typescript',
  ]);
});

test('claimIssue records multiple active issues for the same assignee', () => {
  const progress = createEmptyProgress();
  const issue = {
    number: 12,
    title: '实现录制控制栏',
    labels: ['score:5', 'stack:react', 'status:open'],
  };

  const claimed = claimIssue(progress, issue, 'alice', '2026-05-22T10:00:00.000Z');

  assert.equal(claimed.students.alice.activeIssue, 12);
  assert.deepEqual(claimed.students.alice.activeIssues, [12]);
  assert.equal(claimed.issues['12'].status, 'claimed');
  assert.equal(claimed.issues['12'].assignee, 'alice');

  const secondClaim = claimIssue(
    claimed,
    { ...issue, number: 13, title: '实现章节跳转' },
    'alice',
    '2026-05-22T10:01:00.000Z',
  );

  assert.equal(secondClaim.students.alice.activeIssue, 12);
  assert.deepEqual(secondClaim.students.alice.activeIssues, [12, 13]);
  assert.equal(secondClaim.issues['13'].status, 'claimed');
  assert.equal(secondClaim.issues['13'].assignee, 'alice');
});

test('claimIssue migrates legacy activeIssue when claiming another issue', () => {
  const progress = createEmptyProgress();
  progress.students.alice = {
    activeIssue: 12,
    completedIssues: [],
    reviewedIssues: [],
    bugPenalties: [],
    developmentScore: 0,
    reviewScore: 0,
    penaltyScore: 0,
    totalScore: 0,
  };
  progress.issues['12'] = {
    number: 12,
    title: '实现录制控制栏',
    score: 5,
    stack: ['react'],
    status: 'claimed',
    assignee: 'alice',
    claimedAt: '2026-05-22T10:00:00.000Z',
    closedAt: null,
    mergedPr: null,
  };

  const claimed = claimIssue(
    progress,
    { number: 13, title: '实现章节跳转', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T10:01:00.000Z',
  );

  assert.equal(claimed.students.alice.activeIssue, 12);
  assert.deepEqual(claimed.students.alice.activeIssues, [12, 13]);
});

test('claimIssue validates GitHub issue status and supports repair reruns', () => {
  const progress = createEmptyProgress();

  assert.throws(
    () =>
      claimIssue(
        progress,
        { number: 12, title: '总控', labels: [] },
        'alice',
        '2026-05-22T10:00:00.000Z',
      ),
    /not open for claim/,
  );

  assert.throws(
    () =>
      claimIssue(
        progress,
        {
          number: 12,
          title: '实现录制控制栏',
          labels: ['score:5', 'stack:react', 'status:claimed'],
          assignee: 'bob',
        },
        'alice',
        '2026-05-22T10:00:00.000Z',
      ),
    /already claimed/,
  );

  const repaired = claimIssue(
    progress,
    {
      number: 12,
      title: '实现录制控制栏',
      labels: ['score:5', 'stack:react', 'status:claimed'],
      assignee: 'alice',
    },
    'alice',
    '2026-05-22T10:00:00.000Z',
  );

  assert.equal(repaired.students.alice.activeIssue, 12);
  assert.equal(repaired.issues['12'].assignee, 'alice');
  assert.deepEqual(
    claimIssue(
      repaired,
      {
        number: 12,
        title: '实现录制控制栏',
        labels: ['score:5', 'stack:react', 'status:claimed'],
        assignee: 'alice',
      },
      'alice',
      '2026-05-22T10:00:00.000Z',
    ),
    repaired,
  );
});

test('parseClosingIssues accepts one closing keyword and rejects ambiguous PRs in guard', () => {
  assert.deepEqual(parseClosingIssues('Implements feature.\n\nCloses #12'), [12]);
  assert.deepEqual(parseClosingIssues('Fixes #12\nResolves #13'), [12, 13]);
});

test('findValidReviewer requires first eligible commenter to post CR pass', () => {
  const latestCommitAt = '2026-05-22T10:00:00.000Z';
  const comments = [
    { user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
  ];

  assert.equal(findValidReviewer({ reviews: [], comments, prAuthor: 'carol', latestCommitAt }), 'bob');
  assert.equal(
    findValidReviewer({
      reviews: [{ user: { login: 'alice', type: 'User' }, state: 'APPROVED', submitted_at: '2026-05-22T11:00:00.000Z' }],
      comments: [],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    null,
  );
  assert.equal(
    findValidReviewer({
      reviews: [],
      comments: [{ user: { login: 'dave', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T09:59:00.000Z' }],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    'dave',
  );
});

test('findValidReviewer accepts CR pass from the claimed reviewer in a PR review', () => {
  const comments = [
    { user: { login: 'alice', type: 'User' }, body: 'CR认领', created_at: '2026-05-22T10:05:00.000Z' },
  ];
  const reviews = [
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR通过',
      submitted_at: '2026-05-22T10:30:00.000Z',
    },
  ];

  assert.equal(
    findValidReviewer({
      reviews,
      comments,
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer accepts review submission claim and pass without issue comments', () => {
  const reviews = [
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR认领',
      submitted_at: '2026-05-22T10:05:00.000Z',
    },
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR通过',
      submitted_at: '2026-05-22T10:30:00.000Z',
    },
  ];

  assert.equal(
    findValidReviewer({
      reviews,
      comments: [],
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer accepts review submission CR pass as its own claim', () => {
  const reviews = [
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR通过',
      submitted_at: '2026-05-22T10:30:00.000Z',
    },
  ];

  assert.equal(
    findValidReviewer({
      reviews,
      comments: [],
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer ignores repo guard and merge confirmation when claiming reviewer', () => {
  const comments = [
    { user: { login: 'maintainer', type: 'User' }, body: '确认合并', created_at: '2026-05-22T10:40:00.000Z' },
  ];
  const reviews = [
    {
      user: { login: 'maintainer', type: 'User' },
      state: 'APPROVED',
      body: '> 🛡️ [ceilf6/repo-guard](https://github.com/ceilf6/repo-guard)\n\n自动评审报告',
      submitted_at: '2026-05-22T10:01:00.000Z',
    },
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR认领',
      submitted_at: '2026-05-22T10:05:00.000Z',
    },
    {
      user: { login: 'alice', type: 'User' },
      state: 'APPROVED',
      body: 'CR通过',
      submitted_at: '2026-05-22T10:30:00.000Z',
    },
  ];

  assert.equal(
    findValidReviewer({
      reviews,
      comments,
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer ignores non-signal inline review comments when claiming reviewer', () => {
  const comments = [
    { user: { login: 'alice', type: 'User' }, body: 'CR认领', created_at: '2026-05-22T10:05:00.000Z' },
    { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
  ];
  const reviewComments = [
    {
      user: { login: 'maintainer', type: 'User' },
      body: '这里需要补一个边界测试。',
      created_at: '2026-05-22T10:01:00.000Z',
    },
  ];

  assert.equal(
    findValidReviewer({
      reviews: [],
      reviewComments,
      comments,
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer accepts CR pass from the claimed reviewer in an inline review comment', () => {
  const comments = [
    { user: { login: 'alice', type: 'User' }, body: 'CR认领', created_at: '2026-05-22T10:05:00.000Z' },
  ];
  const reviewComments = [
    { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
  ];

  assert.equal(
    findValidReviewer({
      reviews: [],
      reviewComments,
      comments,
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('findValidReviewer only accepts CR pass from the first eligible PR commenter', () => {
  const latestCommitAt = '2026-05-22T10:00:00.000Z';
  const comments = [
    { user: { login: 'alice', type: 'User' }, body: '这里有个问题需要改', created_at: '2026-05-22T10:05:00.000Z' },
    { user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:20:00.000Z' },
  ];

  assert.equal(findValidReviewer({ reviews: [], comments, prAuthor: 'carol', latestCommitAt }), null);
  assert.equal(
    findValidReviewer({
      reviews: [],
      comments: [
        ...comments,
        { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
      ],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    'alice',
  );
});

test('findValidReviewer ignores bots and the PR author when claiming CR reviewer', () => {
  const latestCommitAt = '2026-05-22T10:00:00.000Z';
  const comments = [
    { user: { login: 'github-actions[bot]', type: 'Bot' }, body: 'repo guard report', created_at: '2026-05-22T10:01:00.000Z' },
    { user: { login: 'carol', type: 'User' }, body: '我补充一下', created_at: '2026-05-22T10:02:00.000Z' },
    { user: { login: 'alice', type: 'User' }, body: '这里要改', created_at: '2026-05-22T10:03:00.000Z' },
    { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
  ];

  assert.equal(findValidReviewer({ reviews: [], comments, prAuthor: 'carol', latestCommitAt }), 'alice');
});

test('findValidReviewer keeps claimant CR pass valid after new commits', () => {
  const comments = [
    { user: { login: 'alice', type: 'User' }, body: '这里要改', created_at: '2026-05-22T10:03:00.000Z' },
    { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
    { user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T11:20:00.000Z' },
  ];

  assert.equal(
    findValidReviewer({
      reviews: [],
      comments,
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
  assert.equal(
    findValidReviewer({
      reviews: [],
      comments: [
        ...comments,
        { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T11:30:00.000Z' },
      ],
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});

test('evaluatePrGuard enforces issue linkage, ownership, protected files and timeout without requiring CR', () => {
  const progress = createEmptyProgress();
  const claimed = claimIssue(
    progress,
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );

  const result = evaluatePrGuard({
    progress: claimed,
    pr: {
      number: 34,
      title: '实现录制控制栏',
      body: 'Closes #12',
      author: 'alice',
      createdAt: '2026-05-22T10:00:00.000Z',
      latestCommitAt: '2026-05-22T10:10:00.000Z',
    },
    issue: { number: 12, labels: ['score:5', 'stack:react', 'status:claimed'], assignee: 'alice' },
    changedFiles: ['src/App.tsx'],
    reviews: [],
    comments: [],
    now: '2026-05-22T11:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 12);
  assert.equal(result.reviewer, null);

  const protectedFile = evaluatePrGuard({
    progress: claimed,
    pr: {
      number: 35,
      title: 'bad',
      body: 'Closes #12',
      author: 'alice',
      createdAt: '2026-05-22T10:00:00.000Z',
      latestCommitAt: '2026-05-22T10:10:00.000Z',
    },
    issue: { number: 12, labels: ['score:5', 'status:claimed'], assignee: 'alice' },
    changedFiles: ['docs/progress.json'],
    reviews: [],
    comments: [{ user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:20:00.000Z' }],
    now: '2026-05-22T11:00:00.000Z',
  });

  assert.equal(protectedFile.ok, false);
  assert.match(protectedFile.reasons.join('\n'), /protected progress files/);
});

test('classifyContractPaths recognizes core architecture surfaces', () => {
  const result = classifyContractPaths([
    'apps/web/src/shared/recording-schema/types.ts',
    'apps/web/src/features/runtime-preview/iframeRuntime.ts',
    'apps/web/src/features/library/recordingStore.ts',
    'apps/web/src/features/player/replayScheduler.ts',
    'scripts/workflows/guard-pr.mjs',
    'docs/技术方案.md',
    'apps/web/src/features/editor/CodeEditor.tsx',
  ]);

  assert.deepEqual(result.critical.map((item) => item.category), [
    'recording-schema',
    'runtime-preview',
    'recording-repository',
    'replay-core',
    'workflow-contract',
    'authority-docs',
  ]);
  assert.deepEqual(result.nonCritical, ['apps/web/src/features/editor/CodeEditor.tsx']);
});

test('combineChangedFiles includes untracked files once', () => {
  assert.deepEqual(
    combineChangedFiles(
      ['scripts/workflows/contract-check.mjs', 'package.json'],
      ['scripts/workflows/contract-check.mjs', 'docs/知识库契约.md'],
    ),
    ['scripts/workflows/contract-check.mjs', 'package.json', 'docs/知识库契约.md'],
  );
});

test('contract diff filter includes deleted files', () => {
  assert.equal(CONTRACT_DIFF_FILTER.includes('D'), true);
});

test('authority docs keep IndexedDB save failure export fallback mandatory', () => {
  const technicalPlan = readFileSync('docs/技术方案.md', 'utf8');

  assert.match(technicalPlan, /文件导出作为保存失败兜底/u);
  assert.match(technicalPlan, /当 IndexedDB 写入失败或 quota 不足时，文件导出是 P0 兜底路径/u);
});

test('technical plan owns P1 cloud contract without standalone cloud plan', () => {
  const technicalPlan = readFileSync('docs/技术方案.md', 'utf8');

  assert.equal(existsSync(standaloneCloudPlanPath()), false);
  assert.match(technicalPlan, /## 十、P1 云端回放中心详细方案/u);
  assert.match(technicalPlan, /后续实现不得再新增独立云端技术方案文档/u);
  assert.match(technicalPlan, /ready --> soft_deleted[\s\S]*soft_deleted --> purging[\s\S]*purging --> deleted/u);
  assert.match(technicalPlan, /`indexes\.json` 是可选派生资产，不是 P1 上传必需资产/u);

  const requiredCloudTopics = [
    /#### 2\. P1 云端目标/u,
    /### 3\. 总体架构/u,
    /### 4\. 领域模型/u,
    /### 5\. 对象存储设计/u,
    /上传使用 session，两阶段完成/u,
    /云端播放页不直接拼对象存储 URL/u,
    /### 7\. API 契约/u,
    /### 8\. 服务端校验与处理/u,
    /### 10\. 权限与安全/u,
    /### 11\. 可靠性与一致性/u,
    /### 14\. 测试与验收/u,
    /### 15\. 实施拆分建议/u,
    /### 16\. 风险与应对/u,
  ];
  for (const pattern of requiredCloudTopics) {
    assert.match(technicalPlan, pattern);
  }

  const p0Invariants = [
    /本章不改变 P0 范围/u,
    /P0 仍以本地 IndexedDB 与文件导出为主/u,
    /不将云端上传作为 P0 保存的唯一出口/u,
    /不在云端回放时重新执行用户历史代码/u,
    /事件流是事实源/u,
  ];
  for (const pattern of p0Invariants) {
    assert.match(technicalPlan, pattern);
  }
});

test('technical plan owns P1 plus AI subtitle architecture and HF token boundary', () => {
  const technicalPlan = readFileSync('docs/技术方案.md', 'utf8');

  assert.match(technicalPlan, /## 十一、P1\+ AI 字幕与 Hugging Face 模型方案/u);
  assert.match(technicalPlan, /字幕、纠错结果和章节属于可重建的派生资产/u);
  assert.match(technicalPlan, /不把字幕写入 `RecordingPackageV1` 主 schema/u);
  assert.match(technicalPlan, /`@huggingface\/transformers`/u);
  assert.match(technicalPlan, /`onnx-community\/whisper-tiny`/u);
  assert.match(technicalPlan, /`language: "chinese"`/u);
  assert.match(technicalPlan, /优先覆盖中文讲解这个主要产品场景/u);
  assert.match(technicalPlan, /有音频的回放页可以提前 warm-up 本地 ASR 模型/u);
  assert.match(technicalPlan, /warm-up 只下载\/初始化模型，不提前转写音频/u);
  assert.match(technicalPlan, /实际音频转写仍只在用户点击后发生/u);
  assert.match(technicalPlan, /同一录制媒体只触发一次 warm-up/u);
  assert.match(technicalPlan, /不得把 token 打包进浏览器 bundle/u);
  assert.match(technicalPlan, /浏览器本地推理只拉取公开模型资产/u);
  assert.match(technicalPlan, /不得携带 Hugging Face token/u);
  assert.match(technicalPlan, /不替代 Whisper\/ASR/u);
  assert.match(technicalPlan, /prompt 只描述目标和输出格式/u);
  assert.match(technicalPlan, /优先保证本地小模型稳定输出可解析 JSON/u);
  assert.match(technicalPlan, /有音频媒体时可以预热本地 LLM/u);
  assert.match(technicalPlan, /默认模型：`ceilf6\/code-tape-subtitle-postprocessor-onnx`/u);
  assert.match(technicalPlan, /优先尝试 WebGPU `q4f16`/u);
  assert.match(technicalPlan, /回退 WASM `q8` \/ `q4`/u);
  assert.match(technicalPlan, /`segments` 是稀疏变更集/u);
  assert.match(technicalPlan, /前端领域术语、组件名、变量名、函数名/u);
  assert.match(technicalPlan, /章节跳转点/u);
  assert.match(technicalPlan, /点击章节调用现有播放器 `seek\(startMs\)`/u);
  assert.match(technicalPlan, /`SubtitleChapterList`/u);
  assert.match(technicalPlan, /chapters: Array/u);
  assert.match(technicalPlan, /完整 P1\+ 模式的模型输出必须总是包含 `chapters` 数组/u);
  assert.match(technicalPlan, /JSON 解析失败[\s\S]*保留原始 ASR 字幕/u);
  assert.match(technicalPlan, /如果只有章节非法而字幕纠错合法[\s\S]*不能污染字幕轨/u);
  assert.match(technicalPlan, /PRD 中“本地 LLM 纠错”和“自动分段生成章节跳转点”必须同时出现在技术方案/u);
});

test('technical plan owns P1 plus WebRTC interview architecture and jitter recovery', () => {
  const technicalPlan = readFileSync('docs/技术方案.md', 'utf8');

  assert.match(technicalPlan, /## 十二、P1\+ WebRTC 实时面试模式方案/u);
  assert.match(technicalPlan, /不改变 P0\/P1 的核心事实源/u);
  assert.match(technicalPlan, /候选人端仍以 `RecordingClock`、`EventBus`、`PackageBuilder` 生成本地录制包/u);
  assert.match(technicalPlan, /面试官端以只读方式实时查看候选人的编辑器稳定状态/u);
  assert.match(technicalPlan, /WebRTC 进行双向音视频通话/u);
  assert.match(technicalPlan, /不引入 CRDT\/OT/u);
  assert.match(technicalPlan, /不默认录制面试官音视频到候选人回放包/u);
  assert.match(technicalPlan, /`RTCPeerConnection` 承载双向音频、双向视频和数据通道/u);
  assert.match(technicalPlan, /RTCDataChannel: events/u);
  assert.match(technicalPlan, /`events` \| `ordered: true`、可靠传输/u);
  assert.match(technicalPlan, /`presence` \| `ordered: false`、`maxRetransmits: 0`/u);
  assert.match(technicalPlan, /`RemoteTimelineBuffer`/u);
  assert.match(technicalPlan, /小延迟播放 \+ 周期快照 \+ hash 校验/u);
  assert.match(technicalPlan, /发现缺口时最多等待/u);
  assert.match(technicalPlan, /收到 `snapshot-request` 后立即发送最新快照/u);
  assert.match(technicalPlan, /`content-change` 后校验 `contentHash`/u);
  assert.match(technicalPlan, /面试结束后候选人保存出的录制包通过现有 `PackageLoader` 和 `ReplayPage` 打开/u);
  assert.match(technicalPlan, /`InterviewRoomService`/u);
  assert.match(technicalPlan, /`InterviewSignalingServer`/u);
  assert.match(technicalPlan, /远端媒体保存扩展属于完整方案，需要产品确认后再实现/u);
});

test('repository text does not reference the standalone cloud plan path', () => {
  const trackedFiles = execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

  const referencedFiles = trackedFiles.filter((filePath) => {
    if (!/\.(css|html|js|json|jsonc|md|mjs|ts|tsx|yml|yaml)$/u.test(filePath)) {
      return false;
    }
    if (!existsSync(filePath)) {
      return false;
    }
    return readFileSync(filePath, 'utf8').includes(standaloneCloudPlanPath());
  });

  assert.deepEqual(referencedFiles, []);
});

test('contract check launches npx through cmd on Windows', () => {
  const contractCheck = readFileSync('scripts/workflows/contract-check.mjs', 'utf8');

  assert.match(contractCheck, /process\.platform === 'win32'/u);
  assert.match(contractCheck, /command: 'cmd\.exe'/u);
  assert.match(contractCheck, /'npx\.cmd'/u);
  assert.match(contractCheck, /execFileSync\(command, args/u);
  assert.doesNotMatch(contractCheck, /execFileSync\('npx'/u);
});

test('contract check reuses an existing CI base ref before fetching', () => {
  const contractCheck = readFileSync('scripts/workflows/contract-check.mjs', 'utf8');

  assert.match(contractCheck, /const baseRef = `origin\/\$\{process\.env\.GITHUB_BASE_REF\}`/u);
  assert.match(contractCheck, /if \(!gitRefExists\(baseRef\)\)/u);
  assert.match(contractCheck, /`\$\{baseRef\}\.\.\.HEAD`/u);
  assert.doesNotMatch(contractCheck, /`origin\/\$\{process\.env\.GITHUB_BASE_REF\}\.\.\.HEAD`/u);
  assert.match(contractCheck, /function gitRefExists\(ref\)/u);
});

test('evaluateGitNexusContract blocks critical changes without tests and impact summary', () => {
  const result = evaluateGitNexusContract({
    changedFiles: ['apps/web/src/shared/recording-schema/validators.ts'],
    impactSummary: '',
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Missing contract test/);
  assert.match(result.reasons.join('\n'), /structured GitNexus impact summary/);
  assert.ok(result.suggestions.some((line) => line.includes('detect_changes')));
});

test('evaluateGitNexusContract rejects placeholder impact summaries', () => {
  const result = evaluateGitNexusContract({
    changedFiles: [
      'apps/web/src/features/runtime-preview/iframeRuntime.ts',
      'apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts',
    ],
    impactSummary: '-',
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /structured GitNexus impact summary/);
});

test('evaluateGitNexusContract rejects unstructured impact summaries', () => {
  const result = evaluateGitNexusContract({
    changedFiles: [
      'apps/web/src/features/runtime-preview/iframeRuntime.ts',
      'apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts',
    ],
    impactSummary: 'I checked GitNexus and it looks fine.',
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /Missing GitNexus impact summary field: 风险等级/);
});

test('extractImpactSummary stops at the next PR template section', () => {
  const summary = extractImpactSummary([
    '## 变更说明',
    '',
    '-',
    '',
    '## GitNexus 影响分析摘要',
    '',
    '-',
    '',
    '## 自检',
    '',
    '- [ ] 已运行 npm run contract:local',
  ].join('\n'));

  const result = evaluateGitNexusContract({
    changedFiles: ['scripts/workflows/contract-check.mjs', 'scripts/tests/workflow-rules.test.mjs'],
    impactSummary: summary,
  });

  assert.equal(summary, '-');
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /structured GitNexus impact summary/);
});

test('pull request template references the control issue without closing it', () => {
  const template = readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');

  assert.match(template, /Refs #2（总控 issue，不在本 PR 中关闭）/u);
  assert.doesNotMatch(template, /Closes #/u);
  assert.match(template, /## 改动点/u);
  assert.match(template, /## 影响范围/u);
  assert.match(template, /## GitNexus 影响分析摘要/u);
  assert.match(template, /已说明改动点和影响范围/u);
});

test('evaluateGitNexusContract accepts critical changes with matching tests and impact summary', () => {
  const result = evaluateGitNexusContract({
    changedFiles: [
      'apps/web/src/shared/recording-schema/validators.ts',
      'apps/web/src/shared/recording-schema/__tests__/validators.test.ts',
    ],
    impactSummary: validGitNexusSummary,
  });

  assert.equal(result.ok, true);
});

test('evaluateGitNexusContract treats non-critical changes as advisory', () => {
  const result = evaluateGitNexusContract({
    changedFiles: ['apps/web/src/features/editor/CodeEditor.tsx'],
    impactSummary: '',
  });

  assert.equal(result.ok, true);
  assert.match(result.warnings.join('\n'), /No critical contract surface changed/);
});

test('README Harness documents local quality hooks', () => {
  const readme = readFileSync('README.md', 'utf8');

  assert.match(readme, /- Git hooks/u);
  assert.match(readme, /`pre-commit` 运行 `npm run quality:precommit`/u);
  assert.match(readme, /`pre-push` 运行 `npm run quality:local`/u);
});

test('agent prompts require codex review before final PR审查', () => {
  for (const promptPath of ['AGENTS.md', 'CLAUDE.md']) {
    const prompt = readFileSync(promptPath, 'utf8');

    assert.match(prompt, /repo-guard 和 codex 以及 Copilot 的评论后进行审查/u);
  }
});

test('feature scoring writes idempotent ledger and clears active issue', () => {
  const progress = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );

  const scored = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });
  const rerun = applyFeatureMerge(scored, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });

  assert.equal(rerun.ledger.length, 1);
  assert.equal(rerun.students.alice.activeIssue, null);
  assert.equal(rerun.students.alice.developmentScore, 3.75);
  assert.equal(rerun.students.bob.reviewScore, 1.25);
  assert.equal(rerun.students.alice.totalScore, 3.75);
});

test('feature scoring supports maintainer-only merge without reviewer', () => {
  const firstClaim = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );
  const progress = claimIssue(
    firstClaim,
    { number: 13, title: '实现章节跳转', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:05:00.000Z',
  );

  const scored = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: null,
    createdAt: '2026-05-22T12:00:00.000Z',
  });

  assert.equal(scored.students.alice.activeIssue, 13);
  assert.deepEqual(scored.students.alice.activeIssues, [13]);
  assert.equal(scored.students.alice.developmentScore, 3.75);
  assert.equal(scored.students.null, undefined);
  assert.equal(scored.ledger[0].reviewer, null);
  assert.equal(scored.ledger[0].reviewerDelta, 0);
});

test('bug fix scoring penalizes original owner and rewards fix owner', () => {
  const progress = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );
  const merged = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });
  const claimedBug = claimIssue(
    merged,
    { number: 41, title: '修复录制控制栏 bug', labels: ['score:5', 'stack:react', 'status:open'] },
    'carol',
    '2026-05-22T13:00:00.000Z',
  );

  const scored = applyBugFixMerge(claimedBug, {
    sourceIssue: 12,
    sourcePr: 34,
    bugIssue: 41,
    fixPr: 45,
    score: 5,
    fixDeveloper: 'carol',
    fixReviewer: 'dave',
    createdAt: '2026-05-22T18:00:00.000Z',
  });

  assert.equal(scored.students.alice.penaltyScore, -7.5);
  assert.equal(scored.students.bob.penaltyScore, -2.5);
  assert.equal(scored.students.carol.developmentScore, 3.75);
  assert.equal(scored.students.dave.reviewScore, 1.25);
  assert.equal(scored.students.carol.activeIssue, null);
});

test('bug fix scoring supports source and fix PRs without reviewers', () => {
  const progress = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );
  const merged = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: null,
    createdAt: '2026-05-22T12:00:00.000Z',
  });
  const claimedBug = claimIssue(
    merged,
    { number: 41, title: '修复录制控制栏 bug', labels: ['score:5', 'stack:react', 'status:open'] },
    'carol',
    '2026-05-22T13:00:00.000Z',
  );

  const scored = applyBugFixMerge(claimedBug, {
    sourceIssue: 12,
    sourcePr: 34,
    bugIssue: 41,
    fixPr: 45,
    score: 5,
    fixDeveloper: 'carol',
    fixReviewer: null,
    createdAt: '2026-05-22T18:00:00.000Z',
  });

  assert.equal(scored.students.alice.penaltyScore, -7.5);
  assert.equal(scored.students.carol.developmentScore, 3.75);
  assert.equal(scored.students.null, undefined);
  assert.equal(scored.ledger[1].originalReviewer, null);
  assert.equal(scored.ledger[1].originalReviewerDelta, 0);
  assert.equal(scored.ledger[1].fixReviewer, null);
  assert.equal(scored.ledger[1].fixReviewerDelta, 0);
});

test('parseBugReferences extracts source issue and PR from bug body', () => {
  assert.deepEqual(
    parseBugReferences('关联原 Issue: #12\n关联原 PR: #34\n复现步骤: ...'),
    { sourceIssue: 12, sourcePr: 34 },
  );
  assert.deepEqual(
    parseBugReferences('### 关联原 Issue\n\n#12\n\n### 关联原 PR\n\n#34\n\n### bug 现象\n\n播放器跳转失败'),
    { sourceIssue: 12, sourcePr: 34 },
  );
});

test('renderProgressMarkdown includes active tasks, score summary and ledger', () => {
  const progress = applyFeatureMerge(
    claimIssue(
      createEmptyProgress(),
      { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
      'alice',
      '2026-05-22T09:00:00.000Z',
    ),
    {
      issue: 12,
      pr: 34,
      score: 5,
      developer: 'alice',
      reviewer: 'bob',
      createdAt: '2026-05-22T12:00:00.000Z',
    },
  );

  const markdown = renderProgressMarkdown(progress);
  assert.match(markdown, /自动生成/);
  assert.match(markdown, /alice/);
  assert.match(markdown, /3\.75/);
  assert.match(markdown, /#12/);
});

test('renderProgressMarkdown includes manual development bonus ledger entries', () => {
  const progress = createEmptyProgress();
  progress.updatedAt = '2026-05-23T14:25:58Z';
  progress.students.alice = {
    activeIssue: null,
    completedIssues: [],
    reviewedIssues: [],
    bugPenalties: [],
    developmentScore: 1,
    reviewScore: 0,
    penaltyScore: 0,
    totalScore: 1,
  };
  progress.ledger.push({
    id: 'manual-bonus-issue-54-alice',
    type: 'manual_development_bonus',
    issue: 54,
    pr: null,
    score: 1,
    developer: 'alice',
    developerDelta: 1,
    reason: 'Discussions #20 建议贡献奖励',
    createdAt: '2026-05-23T14:25:58Z',
  });

  const markdown = renderProgressMarkdown(progress);
  assert.match(markdown, /manual_development_bonus/);
  assert.match(markdown, /\| #54 \| - \| alice \+1\.00 \(Discussions #20 建议贡献奖励\) \|/);
});

test('hasStatus checks labels from both strings and GitHub label objects', () => {
  assert.equal(hasStatus(['status:open'], 'open'), true);
  assert.equal(hasStatus([{ name: 'status:claimed' }], 'claimed'), true);
});

test('pullNumberFromEvent supports workflow_run retry events', () => {
  assert.equal(
    pullNumberFromEvent({
      workflow_run: {
        pull_requests: [{ number: 34 }],
      },
    }),
    34,
  );
});

test('resolvePullNumberFromEvent falls back to workflow_run head sha for fork PRs', async () => {
  const client = {
    async listOpenPulls() {
      return [
        { number: 12, head: { sha: 'old-sha' } },
        { number: 13, head: { sha: 'fork-head-sha' } },
      ];
    },
  };

  assert.equal(
    await resolvePullNumberFromEvent(client, {
      workflow_run: {
        pull_requests: [],
        head_sha: 'fork-head-sha',
      },
    }),
    13,
  );
});

test('auto merge defers fork pull request review events to workflow_run', () => {
  assert.equal(
    shouldDeferAutoMergeForForkReview(
      { review: { state: 'approved' } },
      {
        headRepoFullName: 'student/code-tape',
        baseRepoFullName: 'ceilf6/code-tape',
      },
    ),
    true,
  );
  assert.equal(
    shouldDeferAutoMergeForForkReview(
      { review: { state: 'approved' } },
      {
        headRepoFullName: 'ceilf6/code-tape',
        baseRepoFullName: 'ceilf6/code-tape',
      },
    ),
    false,
  );
  assert.equal(
    shouldDeferAutoMergeForForkReview(
      { issue: { pull_request: {} } },
      {
        headRepoFullName: 'student/code-tape',
        baseRepoFullName: 'ceilf6/code-tape',
      },
    ),
    false,
  );
});

test('auto merge waits only for truly blocked mergeable states', () => {
  assert.equal(shouldWaitForMergeableState('clean'), false);
  assert.equal(shouldWaitForMergeableState('unstable'), true);
  assert.equal(shouldWaitForMergeableState(null), false);
  assert.equal(shouldWaitForMergeableState('unknown'), false);
  assert.equal(shouldWaitForMergeableState('dirty'), true);
  assert.equal(shouldWaitForMergeableState('blocked'), true);
});

test('auto merge waits for required quality checks', () => {
  const requiredChecks = ['Workflow Tests / quality', 'Contract Guard / gitnexus-contract'];

  assert.deepEqual(
    shouldWaitForRequiredChecks({
      requiredChecks,
      checkRuns: [
        { name: 'Workflow Tests / quality', status: 'completed', conclusion: 'success' },
        { name: 'Contract Guard / gitnexus-contract', status: 'completed', conclusion: 'success' },
      ],
    }),
    { wait: false, missing: [], pending: [], failed: [] },
  );

  const blocked = shouldWaitForRequiredChecks({
    requiredChecks,
    checkRuns: [
      { name: 'Workflow Tests / quality', status: 'completed', conclusion: 'failure' },
      { name: 'Contract Guard / gitnexus-contract', status: 'queued', conclusion: null },
    ],
  });

  assert.equal(blocked.wait, true);
  assert.deepEqual(blocked.failed, ['Workflow Tests / quality']);
  assert.deepEqual(blocked.pending, ['Contract Guard / gitnexus-contract']);
  assert.deepEqual(blocked.missing, []);

  assert.deepEqual(
    shouldWaitForRequiredChecks({
      requiredChecks,
      checkRuns: [{ name: 'Workflow Tests / quality', status: 'completed', conclusion: 'success' }],
    }).missing,
    ['Contract Guard / gitnexus-contract'],
  );
});

test('auto merge requires maintainer confirmation after the latest commit', () => {
  const latestCommitAt = '2026-05-22T10:00:00.000Z';
  const comments = [
    { user: { login: 'ceilf6', type: 'User' }, body: '确认合并', created_at: '2026-05-22T09:59:00.000Z' },
    { user: { login: 'alice', type: 'User' }, body: '确认合并', created_at: '2026-05-22T10:10:00.000Z' },
  ];

  assert.equal(
    findMaintainerMergeConfirmation({
      comments,
      maintainerLogin: 'ceilf6',
      latestCommitAt,
    }),
    null,
  );
  assert.equal(
    findMaintainerMergeConfirmation({
      comments: [
        ...comments,
        { user: { login: 'ceilf6', type: 'User' }, body: '确认合并', created_at: '2026-05-22T10:20:00.000Z' },
      ],
      maintainerLogin: 'ceilf6',
      latestCommitAt,
    }),
    'ceilf6',
  );
});

test('root package exposes complete quality gate scripts', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(pkg.scripts.prepare, 'npm run hooks:install');
  assert.equal(pkg.scripts['hooks:install'], 'node scripts/workflows/install-hooks.mjs');
  assert.equal(pkg.scripts['quality:predev'], 'npm run hooks:install && npm run contract:local');
  assert.equal(
    pkg.scripts['quality:precommit'],
    'npm test && npm run build:schema && npm run lint:web && npm run test:schema && npm run test:api && npm run test:web && npm run build',
  );
  assert.equal(
    pkg.scripts['quality:ci'],
    'npm test && npm run build:schema && npm run lint:web && npm run test:schema && npm run test:api && npm run test:web && npm run build && npm run e2e:web',
  );
  assert.equal(pkg.scripts['quality:local'], 'npm run contract:local && npm run quality:ci');
});

test('api package test script runs compiled tests without shell glob expansion', () => {
  const pkg = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));

  assert.equal(pkg.scripts.prebuild, 'npm run build -w @code-tape/recording-schema');
  assert.equal(pkg.scripts.test, 'npm run build && node scripts/run-dist-tests.mjs');
  assert.doesNotMatch(pkg.scripts.test, /\*\*/);
  assert.ok(existsSync('apps/api/scripts/run-dist-tests.mjs'));
});

test('agent prompts separate commit and push quality gates', () => {
  const agentsPrompt = readFileSync('AGENTS.md', 'utf8');
  const claudePrompt = readFileSync('CLAUDE.md', 'utf8');
  const bootstrapScript = readFileSync('scripts/workflows/contract-check.mjs', 'utf8');

  for (const prompt of [agentsPrompt, claudePrompt]) {
    assert.match(prompt, /开始任务前.*`npm run quality:predev`/u);
  }

  assert.match(bootstrapScript, /Before committing code: run npm run quality:precommit/u);
  assert.match(bootstrapScript, /Before pushing or submitting code: run npm run quality:local/u);
});

test('pages workflow deploys the web app with the GitHub Pages contract', () => {
  const workflow = readFileSync('.github/workflows/pages.yml', 'utf8');

  assert.match(workflow, /name:\s*Deploy Pages/);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /GITHUB_PAGES=true npm run build/);
  assert.match(workflow, /cp apps\/web\/dist\/index\.html apps\/web\/dist\/404\.html/);
  assert.match(workflow, /path:\s*apps\/web\/dist/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});

test('repo guard supports fork pull requests without checking out PR code', () => {
  const workflow = readFileSync('.github/workflows/repo-guard.yml', 'utf8');

  assert.match(workflow, /name:\s*Repo Guard/);
  assert.match(workflow, /^\s{2}pull_request_target:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /head\.repo\.full_name\s*==\s*github\.repository/);
  assert.doesNotMatch(workflow, /actions\/checkout@/);
  assert.match(workflow, /ceilf6\/repo-guard@main/);
  assert.match(workflow, /github-token:\s*\$\{\{\s*secrets\.TRAINING_BOT_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test('training PR workflows use the bot token for checkout and API reads when available', () => {
  const guardWorkflow = readFileSync('.github/workflows/pr-guard.yml', 'utf8');
  const autoMergeWorkflow = readFileSync('.github/workflows/pr-auto-merge.yml', 'utf8');

  assert.match(guardWorkflow, /token:\s*\$\{\{\s*secrets\.TRAINING_BOT_TOKEN\s*\|\|\s*github\.token\s*\}\}/);
  assert.match(guardWorkflow, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.TRAINING_BOT_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(autoMergeWorkflow, /token:\s*\$\{\{\s*secrets\.TRAINING_BOT_TOKEN\s*\|\|\s*github\.token\s*\}\}/);
});
