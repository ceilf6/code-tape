import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('claimIssue records active issue and rejects second active task', () => {
  const progress = createEmptyProgress();
  const issue = {
    number: 12,
    title: '实现录制控制栏',
    labels: ['score:5', 'stack:react', 'status:open'],
  };

  const claimed = claimIssue(progress, issue, 'alice', '2026-05-22T10:00:00.000Z');

  assert.equal(claimed.students.alice.activeIssue, 12);
  assert.equal(claimed.issues['12'].status, 'claimed');
  assert.equal(claimed.issues['12'].assignee, 'alice');
  assert.throws(
    () => claimIssue(claimed, { ...issue, number: 13 }, 'alice', '2026-05-22T10:01:00.000Z'),
    /already has active issue #12/,
  );
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

test('evaluatePrGuard enforces issue linkage, ownership, protected files, CR and timeout', () => {
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
    comments: [{ user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:20:00.000Z' }],
    now: '2026-05-22T11:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 12);
  assert.equal(result.reviewer, 'bob');

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
  assert.equal(pkg.scripts['quality:precommit'], 'npm test && npm run lint:web && npm run test:web && npm run build');
  assert.equal(pkg.scripts['quality:ci'], 'npm test && npm run lint:web && npm run test:web && npm run build && npm run e2e:web');
  assert.equal(pkg.scripts['quality:local'], 'npm run contract:local && npm run quality:ci');
});

test('agent prompt separates predev and local quality gate phases', () => {
  const agentsPrompt = readFileSync('AGENTS.md', 'utf8');

  assert.match(agentsPrompt, /开始任务前.*`npm run quality:predev`/u);
  assert.match(agentsPrompt, /提交.*推送前.*`npm run quality:local`/u);
  assert.doesNotMatch(agentsPrompt, /`npm run quality:predev`\s*\/\s*`npm run quality:local`/u);
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
});
