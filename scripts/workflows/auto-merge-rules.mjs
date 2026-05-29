export function shouldDeferAutoMergeForForkReview(event, pr) {
  const isReviewEvent = Boolean(event?.review);
  const isForkPr =
    pr?.headRepoFullName &&
    pr?.baseRepoFullName &&
    pr.headRepoFullName !== pr.baseRepoFullName;

  return Boolean(isReviewEvent && isForkPr);
}

const requiredAutomatedReviewSignals = [
  {
    key: 'repoGuard',
    label: 'Repo Guard',
    matches: (item, { trustedRepoGuardLogin }) =>
      Boolean(trustedRepoGuardLogin) &&
      itemLoginMatches(item, trustedRepoGuardLogin) &&
      /\[ceilf6\/repo-guard\]/iu.test(itemBody(item)),
  },
  {
    key: 'codex',
    label: 'Codex',
    matches: (item) => itemLoginMatches(item, 'chatgpt-codex-connector') && /Codex Review/u.test(itemBody(item)),
  },
  {
    key: 'copilot',
    label: 'Copilot',
    matches: (item) => itemLoginMatches(item, 'copilot-pull-request-reviewer'),
  },
];

function commentLogin(comment) {
  return comment?.user?.login;
}

function commentCreatedAt(comment) {
  return comment?.created_at || comment?.createdAt;
}

function itemLogin(item) {
  return item?.user?.login || item?.author?.login;
}

function normalizedItemLogin(item) {
  return itemLogin(item)?.replace(/\[bot\]$/u, '');
}

function itemLoginMatches(item, expectedLogin) {
  return normalizedItemLogin(item) === expectedLogin;
}

function itemBody(item) {
  return item?.body ?? '';
}

function itemCreatedAt(item) {
  return item?.submitted_at || item?.submittedAt || item?.created_at || item?.createdAt;
}

function itemCommitId(item) {
  return item?.commit_id || item?.commitId || item?.commit?.oid;
}

function isAfterLatestCommit(item, latestCommitAt, latestCommitSha) {
  const createdAt = itemCreatedAt(item);
  if (!createdAt) {
    return false;
  }

  const commitId = itemCommitId(item);
  if (latestCommitSha) {
    return commitId === latestCommitSha;
  }

  return Date.parse(createdAt) >= Date.parse(latestCommitAt || '1970-01-01T00:00:00.000Z');
}

export function findAutomatedReviewSignals({
  reviews = [],
  reviewComments = [],
  comments = [],
  latestCommitAt,
  latestCommitSha,
  trustedRepoGuardLogin,
}) {
  const items = [...reviews, ...reviewComments, ...comments].filter((item) =>
    isAfterLatestCommit(item, latestCommitAt, latestCommitSha),
  );
  const signals = {};
  const missing = [];

  for (const signal of requiredAutomatedReviewSignals) {
    const matches = items
      .filter((item) => signal.matches(item, { trustedRepoGuardLogin }))
      .sort((left, right) => Date.parse(itemCreatedAt(right)) - Date.parse(itemCreatedAt(left)));
    const latest = matches[0];
    if (!latest) {
      missing.push(signal.label);
      continue;
    }

    signals[signal.key] = {
      label: signal.label,
      at: itemCreatedAt(latest),
      login: itemLogin(latest) ?? null,
    };
  }

  const signalTimes = Object.values(signals).map((signal) => signal.at);
  const latestSignalAt =
    missing.length === 0
      ? signalTimes.sort((left, right) => Date.parse(right) - Date.parse(left))[0]
      : null;

  return {
    wait: missing.length > 0,
    missing,
    latestSignalAt,
    signals,
  };
}

export function findMaintainerMergeConfirmation({ comments = [], maintainerLogin, latestCommitAt }) {
  if (!maintainerLogin) {
    return null;
  }

  const latestCommitTime = Date.parse(latestCommitAt || '1970-01-01T00:00:00.000Z');
  const confirmation = comments.find((comment) => {
    const createdAt = commentCreatedAt(comment);
    return (
      commentLogin(comment) === maintainerLogin &&
      comment?.body?.trim() === '确认合并' &&
      Date.parse(createdAt) >= latestCommitTime
    );
  });

  return commentLogin(confirmation) ?? null;
}

export function shouldWaitForRequiredChecks({ requiredChecks, checkRuns }) {
  const byName = new Map((checkRuns ?? []).map((check) => [check.name, check]));
  const missing = [];
  const pending = [];
  const failed = [];

  for (const name of requiredChecks) {
    const check = byName.get(name);
    if (!check) {
      missing.push(name);
    } else if (check.status !== 'completed') {
      pending.push(name);
    } else if (check.conclusion !== 'success') {
      failed.push(name);
    }
  }

  return {
    wait: missing.length > 0 || pending.length > 0 || failed.length > 0,
    missing,
    pending,
    failed,
  };
}
