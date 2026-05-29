import { loadPrGuardContext } from './action-context.mjs';
import {
  findMaintainerMergeConfirmation,
  shouldDeferAutoMergeForForkReview,
  shouldWaitForRequiredChecks,
} from './auto-merge-rules.mjs';
import { evaluatePrGuard } from './guard-pr.mjs';
import { GitHubClient, readEvent } from './github-client.mjs';
import { shouldWaitForMergeableState } from './mergeable-state.mjs';

const requiredAutoMergeChecks = ['Workflow Tests / quality', 'Contract Guard / gitnexus-contract'];

const event = await readEvent();
if (event.workflow_run && event.workflow_run.conclusion !== 'success') {
  console.log(`workflow_run conclusion is ${event.workflow_run.conclusion}; skipping auto merge`);
  process.exit(0);
}

const client = new GitHubClient();
let context;
try {
  context = await loadPrGuardContext(client, event);
} catch (error) {
  if (/does not reference a pull request/.test(error.message)) {
    console.log('event does not reference a pull request; skipping auto merge');
    process.exit(0);
  }
  throw error;
}
const result = evaluatePrGuard({
  ...context,
  now: new Date().toISOString(),
});

if (!result.ok) {
  console.log(`PR #${context.pr.number} is not ready to merge:\n- ${result.reasons.join('\n- ')}`);
  process.exit(0);
}

if (context.rawPull.draft) {
  console.log(`PR #${context.pr.number} is draft; skipping auto merge`);
  process.exit(0);
}

if (shouldDeferAutoMergeForForkReview(event, context.pr)) {
  console.log(`PR #${context.pr.number} is from a fork review event; waiting for workflow_run with write permissions`);
  process.exit(0);
}

const maintainerLogin = context.rawPull.base.repo?.owner?.login ?? context.pr.baseRepoFullName?.split('/')[0];
const mergeConfirmer = findMaintainerMergeConfirmation({
  comments: context.comments,
  maintainerLogin,
  latestCommitAt: context.pr.latestCommitAt,
});
if (!mergeConfirmer) {
  console.log(`PR #${context.pr.number} is waiting for @${maintainerLogin} to comment 确认合并 after the latest commit`);
  process.exit(0);
}

if (shouldWaitForMergeableState(context.rawPull.mergeable_state)) {
  console.log(`PR #${context.pr.number} mergeable_state is ${context.rawPull.mergeable_state}; waiting for branch protection and checks`);
  process.exit(0);
}

const requiredCheckResult = shouldWaitForRequiredChecks({
  requiredChecks: requiredAutoMergeChecks,
  checkRuns: await client.listCheckRunsForRef(context.rawPull.head.sha),
});
if (requiredCheckResult.wait) {
  const reasons = [
    ...requiredCheckResult.missing.map((name) => `missing ${name}`),
    ...requiredCheckResult.pending.map((name) => `pending ${name}`),
    ...requiredCheckResult.failed.map((name) => `failed ${name}`),
  ];
  console.log(`PR #${context.pr.number} is waiting for required checks:\n- ${reasons.join('\n- ')}`);
  process.exit(0);
}

await client.mergePull(context.pr.number, {
  commitTitle: `#${result.issueNumber} ${context.rawPull.title}`,
  commitMessage: `Closes #${result.issueNumber}\n\nMerged automatically after workflow guard and maintainer confirmation passed.`,
});

if (context.pr.headRepoFullName === context.pr.baseRepoFullName && context.pr.headRef !== 'main') {
  await client.deleteBranch(context.pr.headRef);
}

console.log(`merged PR #${context.pr.number} for issue #${result.issueNumber}`);
