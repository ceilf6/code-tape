import { hasStatus, parseScore, parseStack } from './issue-parser.mjs';
import { readFile, writeFile } from 'node:fs/promises';

export async function readProgress(path = 'docs/progress.json') {
  try {
    const raw = await readFile(path, 'utf8');
    return ensureProgressShape(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyProgress();
    }
    throw error;
  }
}

export async function writeProgress(progress, path = 'docs/progress.json') {
  await writeFile(path, `${JSON.stringify(ensureProgressShape(progress), null, 2)}\n`, 'utf8');
}

export function createEmptyProgress() {
  return {
    version: 1,
    updatedAt: null,
    students: {},
    issues: {},
    ledger: [],
  };
}

export function ensureProgressShape(progress) {
  return {
    version: progress?.version ?? 1,
    updatedAt: progress?.updatedAt ?? null,
    students: progress?.students ?? {},
    issues: progress?.issues ?? {},
    ledger: progress?.ledger ?? [],
  };
}

export function ensureStudent(progress, username) {
  if (!progress.students[username]) {
    progress.students[username] = {
      activeIssue: null,
      completedIssues: [],
      reviewedIssues: [],
      bugPenalties: [],
      developmentScore: 0,
      reviewScore: 0,
      penaltyScore: 0,
      totalScore: 0,
    };
  }
  return progress.students[username];
}

export function cloneProgress(progress) {
  return structuredClone(ensureProgressShape(progress));
}

export function claimIssue(progress, issue, username, claimedAt) {
  const next = cloneProgress(progress);
  const student = ensureStudent(next, username);
  if (student.activeIssue && student.activeIssue !== issue.number) {
    throw new Error(`${username} already has active issue #${student.activeIssue}`);
  }

  const existingIssue = next.issues[String(issue.number)];
  if (existingIssue?.status === 'claimed') {
    if (existingIssue.assignee === username && student.activeIssue === issue.number) {
      return next;
    }
    throw new Error(`issue #${issue.number} is already claimed`);
  }

  const assignee = issue.assignee ?? null;
  if (hasStatus(issue.labels, 'claimed')) {
    if (assignee !== username) {
      throw new Error(`issue #${issue.number} is already claimed`);
    }
  } else if (!hasStatus(issue.labels, 'open')) {
    throw new Error(`issue #${issue.number} is not open for claim`);
  }

  if (assignee && assignee !== username) {
    throw new Error(`issue #${issue.number} is assigned to ${assignee}`);
  }

  const score = parseScore(issue.labels);
  const stack = parseStack(issue.labels);
  student.activeIssue = issue.number;
  next.issues[String(issue.number)] = {
    number: issue.number,
    title: issue.title ?? '',
    score,
    stack,
    status: 'claimed',
    assignee: username,
    claimedAt,
    closedAt: null,
    mergedPr: null,
  };
  touch(next, claimedAt);
  return next;
}

export function applyFeatureMerge(progress, payload) {
  const next = cloneProgress(progress);
  const id = `pr-${payload.pr}-merge`;
  if (hasLedger(next, id)) {
    return next;
  }

  const hasReviewer = Boolean(payload.reviewer);
  const developerDelta = roundScore(payload.score * (hasReviewer ? 0.75 : 1));
  const reviewerDelta = hasReviewer ? roundScore(payload.score * 0.25) : 0;
  const developer = ensureStudent(next, payload.developer);
  const reviewer = hasReviewer ? ensureStudent(next, payload.reviewer) : null;

  developer.developmentScore = roundScore(developer.developmentScore + developerDelta);
  developer.totalScore = roundScore(developer.totalScore + developerDelta);
  developer.activeIssue = developer.activeIssue === payload.issue ? null : developer.activeIssue;
  pushUnique(developer.completedIssues, payload.issue);

  if (reviewer) {
    reviewer.reviewScore = roundScore(reviewer.reviewScore + reviewerDelta);
    reviewer.totalScore = roundScore(reviewer.totalScore + reviewerDelta);
    pushUnique(reviewer.reviewedIssues, payload.issue);
  }

  const issue = next.issues[String(payload.issue)] ?? { number: payload.issue };
  next.issues[String(payload.issue)] = {
    ...issue,
    status: 'closed',
    closedAt: payload.createdAt,
    mergedPr: payload.pr,
  };

  next.ledger.push({
    id,
    type: 'feature_merge',
    issue: payload.issue,
    pr: payload.pr,
    score: payload.score,
    developer: payload.developer,
    reviewer: payload.reviewer ?? null,
    developerDelta,
    reviewerDelta,
    createdAt: payload.createdAt,
  });
  touch(next, payload.createdAt);
  return next;
}

export function applyBugFixMerge(progress, payload) {
  const next = cloneProgress(progress);
  const id = `bug-${payload.bugIssue}-fix-pr-${payload.fixPr}`;
  if (hasLedger(next, id)) {
    return next;
  }

  const sourceEntry = next.ledger.find(
    (entry) =>
      entry.type === 'feature_merge' &&
      entry.issue === payload.sourceIssue &&
      entry.pr === payload.sourcePr,
  );
  if (!sourceEntry) {
    throw new Error(`cannot find feature merge ledger for issue #${payload.sourceIssue} and PR #${payload.sourcePr}`);
  }

  const originalDeveloperDelta = roundScore(-payload.score * 1.5);
  const hasOriginalReviewer = Boolean(sourceEntry.reviewer);
  const hasFixReviewer = Boolean(payload.fixReviewer);
  const originalReviewerDelta = hasOriginalReviewer ? roundScore(-payload.score * 0.5) : 0;
  const fixDeveloperDelta = roundScore(payload.score * (hasFixReviewer ? 0.75 : 1));
  const fixReviewerDelta = hasFixReviewer ? roundScore(payload.score * 0.25) : 0;

  const originalDeveloper = ensureStudent(next, sourceEntry.developer);
  const originalReviewer = hasOriginalReviewer ? ensureStudent(next, sourceEntry.reviewer) : null;
  const fixDeveloper = ensureStudent(next, payload.fixDeveloper);
  const fixReviewer = hasFixReviewer ? ensureStudent(next, payload.fixReviewer) : null;

  applyPenalty(originalDeveloper, payload.bugIssue, originalDeveloperDelta);
  if (originalReviewer) {
    applyPenalty(originalReviewer, payload.bugIssue, originalReviewerDelta);
  }

  fixDeveloper.developmentScore = roundScore(fixDeveloper.developmentScore + fixDeveloperDelta);
  fixDeveloper.totalScore = roundScore(fixDeveloper.totalScore + fixDeveloperDelta);
  fixDeveloper.activeIssue = fixDeveloper.activeIssue === payload.bugIssue ? null : fixDeveloper.activeIssue;
  pushUnique(fixDeveloper.completedIssues, payload.bugIssue);

  if (fixReviewer) {
    fixReviewer.reviewScore = roundScore(fixReviewer.reviewScore + fixReviewerDelta);
    fixReviewer.totalScore = roundScore(fixReviewer.totalScore + fixReviewerDelta);
    pushUnique(fixReviewer.reviewedIssues, payload.bugIssue);
  }

  const issue = next.issues[String(payload.bugIssue)] ?? { number: payload.bugIssue };
  next.issues[String(payload.bugIssue)] = {
    ...issue,
    status: 'closed',
    closedAt: payload.createdAt,
    mergedPr: payload.fixPr,
  };

  next.ledger.push({
    id,
    type: 'bug_fix_merge',
    sourceIssue: payload.sourceIssue,
    sourcePr: payload.sourcePr,
    bugIssue: payload.bugIssue,
    fixPr: payload.fixPr,
    score: payload.score,
    originalDeveloper: sourceEntry.developer,
    originalReviewer: sourceEntry.reviewer ?? null,
    fixDeveloper: payload.fixDeveloper,
    fixReviewer: payload.fixReviewer ?? null,
    originalDeveloperDelta,
    originalReviewerDelta,
    fixDeveloperDelta,
    fixReviewerDelta,
    createdAt: payload.createdAt,
  });
  touch(next, payload.createdAt);
  return next;
}

export function roundScore(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function applyPenalty(student, issue, delta) {
  student.penaltyScore = roundScore(student.penaltyScore + delta);
  student.totalScore = roundScore(student.totalScore + delta);
  student.bugPenalties.push({ issue, delta });
}

function hasLedger(progress, id) {
  return progress.ledger.some((entry) => entry.id === id);
}

function pushUnique(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function touch(progress, at) {
  progress.updatedAt = at;
}
