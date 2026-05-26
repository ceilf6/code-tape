const closingKeywordPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const ignoredReviewerLogins = new Set(['github-actions[bot]']);

export function parseClosingIssues(body = '') {
  const issues = [];
  for (const match of body.matchAll(closingKeywordPattern)) {
    issues.push(Number(match[1]));
  }
  return [...new Set(issues)];
}

export function requireSingleClosingIssue(body = '') {
  const issues = parseClosingIssues(body);
  if (issues.length !== 1) {
    throw new Error(`expected exactly one closing issue, got ${issues.length}`);
  }
  return issues[0];
}

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
  const sortedComments = [...comments].sort(
    (a, b) => Date.parse(commentCreatedAt(a)) - Date.parse(commentCreatedAt(b)),
  );
  const claimedComment = sortedComments.find((comment) => isEligibleReviewerComment(comment, prAuthor));
  return commentLogin(claimedComment) ?? null;
}

export function findValidReviewer({ comments = [], prAuthor }) {
  const claimedReviewer = findClaimedReviewer({ comments, prAuthor });
  if (!claimedReviewer) {
    return null;
  }

  const hasPass = comments.some(
    (comment) => commentLogin(comment) === claimedReviewer && comment?.body?.trim() === 'CR通过',
  );

  return hasPass ? claimedReviewer : null;
}

export function isTimedOut(createdAt, now, hours = 24) {
  return Date.parse(now) - Date.parse(createdAt) > hours * 60 * 60 * 1000;
}
