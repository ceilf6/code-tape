import { hasStatus } from './issue-parser.mjs';
import { findValidReviewer, isTimedOut, parseClosingIssues } from './pr-parser.mjs';
import { loadPrGuardContext } from './action-context.mjs';
import { GitHubClient, readEvent } from './github-client.mjs';

export const protectedProgressFiles = new Set(['docs/progress.json', 'docs/progress.md']);

export function evaluatePrGuard({
  progress,
  pr,
  issue,
  changedFiles = [],
  reviews = [],
  reviewComments = [],
  comments = [],
  now,
}) {
  const reasons = [];
  const closingIssues = parseClosingIssues(pr.body ?? '');
  const issueNumber = closingIssues.length === 1 ? closingIssues[0] : null;

  if (closingIssues.length !== 1) {
    reasons.push(`PR body must contain exactly one closing issue, found ${closingIssues.length}`);
  }

  if (issueNumber && issue?.number !== issueNumber) {
    reasons.push(`loaded issue #${issue?.number ?? 'unknown'} does not match PR closing issue #${issueNumber}`);
  }

  if (issue && !hasStatus(issue.labels, 'claimed')) {
    reasons.push(`issue #${issue.number} must have status:claimed`);
  }

  const recordedIssue = issueNumber ? progress?.issues?.[String(issueNumber)] : null;
  const owner = recordedIssue?.assignee ?? issue?.assignee;
  if (issueNumber && !owner) {
    reasons.push(`issue #${issueNumber} has no recorded assignee`);
  }
  if (owner && pr.author !== owner) {
    reasons.push(`PR author ${pr.author} must match issue assignee ${owner}`);
  }

  const protectedChanges = changedFiles.filter((file) => protectedProgressFiles.has(file));
  if (protectedChanges.length > 0) {
    reasons.push(`PR must not modify protected progress files: ${protectedChanges.join(', ')}`);
  }

  const reviewer = findValidReviewer({
    reviews,
    reviewComments,
    comments,
    prAuthor: pr.author,
    latestCommitAt: pr.latestCommitAt,
  });

  if (isTimedOut(pr.createdAt, now)) {
    reasons.push('PR is older than 24 hours');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    issueNumber,
    reviewer,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const event = await readEvent();
  const client = new GitHubClient();
  const context = await loadPrGuardContext(client, event);
  const result = evaluatePrGuard({
    ...context,
    now: new Date().toISOString(),
  });

  const summary = result.ok
    ? `PR #${context.pr.number} workflow guard passed for issue #${result.issueNumber}; reviewer: ${result.reviewer ?? 'none'}.`
    : `PR #${context.pr.number} workflow guard failed:\n- ${result.reasons.join('\n- ')}`;

  console.log(summary);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `ok=${result.ok}\nissue=${result.issueNumber ?? ''}\nreviewer=${result.reviewer ?? ''}\n`);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}
