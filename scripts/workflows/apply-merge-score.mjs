import { progressJsonPath } from './config.mjs';
import { loadPrGuardContext } from './action-context.mjs';
import { GitHubClient, readEvent } from './github-client.mjs';
import { parseBugReferences, parseScore } from './issue-parser.mjs';
import { findValidReviewer } from './pr-parser.mjs';
import {
  applyBugFixMerge,
  applyFeatureMerge,
  readProgress,
  writeProgress,
} from './progress-store.mjs';
import { writeRenderedProgress } from './write-rendered-progress.mjs';

const event = await readEvent();
if (!event.pull_request?.merged) {
  console.log('pull request was closed without merge; skipping score update');
  process.exit(0);
}

const client = new GitHubClient();
const context = await loadPrGuardContext(client, event);
const score = parseScore(context.rawIssue.labels);
const reviewer = findValidReviewer({
  reviews: context.reviews,
  reviewComments: context.reviewComments,
  comments: context.comments,
  prAuthor: context.pr.author,
  latestCommitAt: context.pr.latestCommitAt,
});

let progress = await readProgress(progressJsonPath);
const createdAt = event.pull_request.merged_at ?? new Date().toISOString();

try {
  const bugRefs = parseBugReferences(context.rawIssue.body ?? '');
  progress = applyBugFixMerge(progress, {
    sourceIssue: bugRefs.sourceIssue,
    sourcePr: bugRefs.sourcePr,
    bugIssue: context.rawIssue.number,
    fixPr: context.pr.number,
    score,
    fixDeveloper: context.pr.author,
    fixReviewer: reviewer,
    createdAt,
  });
} catch (error) {
  if (!/bug issue body/.test(error.message)) {
    throw error;
  }
  progress = applyFeatureMerge(progress, {
    issue: context.rawIssue.number,
    pr: context.pr.number,
    score,
    developer: context.pr.author,
    reviewer,
    createdAt,
  });
}

await client.removeLabel(context.rawIssue.number, 'status:claimed');
await client.closeIssue(context.rawIssue.number);
await writeProgress(progress, progressJsonPath);
await writeRenderedProgress(progress);
console.log(`updated score ledger for PR #${context.pr.number}`);
