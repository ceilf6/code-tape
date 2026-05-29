export function renderProgressMarkdown(progress) {
  const students = Object.entries(progress.students ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const activeRows = Object.entries(progress.issues ?? {})
    .map(([, issue]) => issue)
    .filter((issue) => issue.status === 'claimed')
    .sort((a, b) => a.number - b.number);
  const ledger = [...(progress.ledger ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return [
    '# 训练营进度与积分',
    '',
    '> 本文件由 GitHub Actions 自动生成，请勿手动修改。',
    '',
    `更新时间：${progress.updatedAt ?? '尚未生成'}`,
    '',
    '## 当前任务',
    '',
    table(
      ['GitHub 用户', '当前 Issue', '认领时间'],
      activeRows.map((issue) => [
        issue.assignee ?? '',
        issueLink(issue.number, issue.title),
        formatTime(issue.claimedAt),
      ]),
    ),
    '',
    '## 积分总览',
    '',
    table(
      ['GitHub 用户', '开发分', 'CR 分', '扣分', '总分'],
      students.map(([username, student]) => [
        username,
        formatScore(student.developmentScore),
        formatScore(student.reviewScore),
        formatScore(student.penaltyScore),
        formatScore(student.totalScore),
      ]),
    ),
    '',
    '## 最近流水',
    '',
    table(
      ['时间', '类型', 'Issue', 'PR', '变更'],
      ledger.slice(0, 20).map((entry) => [
        formatTime(entry.createdAt),
        entry.type,
        issueColumn(entry),
        prColumn(entry),
        deltaColumn(entry),
      ]),
    ),
    '',
  ].join('\n');
}

function table(headers, rows) {
  const safeRows = rows.length > 0 ? rows : [headers.map(() => '-')];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function issueLink(number, title = '') {
  return number ? `#${number} ${title}`.trim() : '-';
}

function issueColumn(entry) {
  if (entry.type === 'bug_fix_merge') {
    return `#${entry.bugIssue} (源 #${entry.sourceIssue})`;
  }
  return `#${entry.issue}`;
}

function prColumn(entry) {
  if (entry.type === 'bug_fix_merge') {
    return `#${entry.fixPr}`;
  }
  if (entry.type === 'manual_development_bonus') {
    return '-';
  }
  return `#${entry.pr}`;
}

function deltaColumn(entry) {
  if (entry.type === 'bug_fix_merge') {
    return compact([
      `${entry.originalDeveloper} ${formatSigned(entry.originalDeveloperDelta)}`,
      entry.originalReviewer ? `${entry.originalReviewer} ${formatSigned(entry.originalReviewerDelta)}` : null,
      `${entry.fixDeveloper} ${formatSigned(entry.fixDeveloperDelta)}`,
      entry.fixReviewer ? `${entry.fixReviewer} ${formatSigned(entry.fixReviewerDelta)}` : null,
    ]).join(', ');
  }
  if (entry.type === 'manual_development_bonus') {
    const reason = entry.reason ? ` (${entry.reason})` : '';
    return `${entry.developer} ${formatSigned(entry.developerDelta)}${reason}`;
  }
  return compact([
    `${entry.developer} ${formatSigned(entry.developerDelta)}`,
    entry.reviewer ? `${entry.reviewer} ${formatSigned(entry.reviewerDelta)}` : null,
  ]).join(', ');
}

function compact(items) {
  return items.filter(Boolean);
}

function formatTime(value) {
  return value ? value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '-';
}

function formatScore(value = 0) {
  return Number(value).toFixed(2);
}

function formatSigned(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${formatScore(value)}`;
}
