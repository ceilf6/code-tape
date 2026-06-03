# PR CR Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR CR pass depend on the first eligible PR commenter, so only that reviewer can later pass the PR with an exact `CR通过` comment.

**Architecture:** Keep the public workflow contract unchanged: `findValidReviewer` still returns the scoring reviewer login or `null`. Internally, `pr-parser.mjs` first derives the claimed reviewer from issue comments, then checks whether that same reviewer posted `CR通过` after the latest commit.

**Tech Stack:** Node.js ESM, `node:test`, GitHub Actions workflow helper scripts.

---

## File Structure

- Modify `scripts/workflows/pr-parser.mjs`: add automatic reviewer claim parsing and update valid reviewer detection.
- Modify `scripts/tests/workflow-rules.test.mjs`: add focused regression tests for reviewer claim behavior.
- Read-only reference `scripts/workflows/guard-pr.mjs`: validates that `evaluatePrGuard` consumes `findValidReviewer` without API changes.
- Read-only reference `scripts/workflows/apply-merge-score.mjs`: validates scoring continues to use the same reviewer result.

### Task 1: Add failing CR claim tests

**Files:**
- Modify: `scripts/tests/workflow-rules.test.mjs`
- Test: `scripts/tests/workflow-rules.test.mjs`

- [x] **Step 1: Write the failing tests**

Add tests near the existing `findValidReviewer accepts approve or CR comment after latest commit` test:

```js
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
      comments: [...comments, { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' }],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    'alice',
  );
});
```

Add a second test for ignored actors:

```js
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
```

Add a third test for push invalidation:

```js
test('findValidReviewer keeps claimant after new commits but requires a fresh CR pass', () => {
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
    null,
  );
  assert.equal(
    findValidReviewer({
      reviews: [],
      comments: [...comments, { user: { login: 'alice', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T11:30:00.000Z' }],
      prAuthor: 'carol',
      latestCommitAt: '2026-05-22T11:00:00.000Z',
    }),
    'alice',
  );
});
```

- [x] **Step 2: Run tests to verify red**

Run: `npm test`

Expected: the new tests fail because current code lets Bob pass with `CR通过`, ignores no claim boundary, and accepts old review-style behavior.

### Task 2: Implement automatic CR reviewer claim

**Files:**
- Modify: `scripts/workflows/pr-parser.mjs`
- Test: `scripts/tests/workflow-rules.test.mjs`

- [x] **Step 1: Update parser implementation**

Replace `findValidReviewer` internals with a claim-first rule and add helper functions:

```js
const ignoredReviewerLogins = new Set(['github-actions[bot]']);

function commentLogin(comment) {
  return comment?.user?.login;
}

function commentCreatedAt(comment) {
  return comment?.created_at || comment?.createdAt;
}

function isEligibleReviewerComment(comment, prAuthor) {
  const login = commentLogin(comment);
  const type = comment?.user?.type;
  return Boolean(login) && login !== prAuthor && type !== 'Bot' && !ignoredReviewerLogins.has(login);
}

export function findClaimedReviewer({ comments = [], prAuthor }) {
  const sortedComments = [...comments].sort((a, b) => Date.parse(commentCreatedAt(a)) - Date.parse(commentCreatedAt(b)));
  const claimedComment = sortedComments.find((comment) => isEligibleReviewerComment(comment, prAuthor));
  return commentLogin(claimedComment) ?? null;
}

export function findValidReviewer({ comments = [], prAuthor, latestCommitAt }) {
  const latestCommitTime = Date.parse(latestCommitAt || '1970-01-01T00:00:00.000Z');
  const claimedReviewer = findClaimedReviewer({ comments, prAuthor });
  if (!claimedReviewer) {
    return null;
  }

  const hasFreshPass = comments.some((comment) => {
    const createdAt = commentCreatedAt(comment);
    return (
      commentLogin(comment) === claimedReviewer &&
      comment?.body?.trim() === 'CR通过' &&
      Date.parse(createdAt) >= latestCommitTime
    );
  });

  return hasFreshPass ? claimedReviewer : null;
}
```

- [x] **Step 2: Run tests to verify green**

Run: `npm test`

Expected: all workflow tests pass.

### Task 3: Align existing tests and docs with the new rule

**Files:**
- Modify: `scripts/tests/workflow-rules.test.mjs`
- Modify: `docs/superpowers/specs/规范工作流技术方案.md`
- Modify: `docs/规范工作流程.md`

- [x] **Step 1: Update old test expectations**

Rename the old test from `findValidReviewer accepts approve or CR comment after latest commit` to `findValidReviewer requires first eligible commenter to post CR pass after latest commit`, and remove the `APPROVED` review acceptance expectation.

- [x] **Step 2: Update workflow docs**

In `docs/superpowers/specs/规范工作流技术方案.md` and `docs/规范工作流程.md`, replace the old approve-or-comment wording with: first eligible PR conversation commenter claims CR; only that reviewer can pass with exact `CR通过`; Bot and PR author comments are ignored.

- [x] **Step 3: Run final verification**

Run: `npm test`

Expected: all tests pass with no failures.
