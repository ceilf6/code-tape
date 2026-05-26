import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  CONTRACT_DIFF_FILTER,
  combineChangedFiles,
  evaluateGitNexusContract,
  extractImpactSummary,
} from './contract-rules.mjs';

const GITNEXUS_VERSION = '1.6.5';
const DEFAULT_LOCAL_ANALYZE_TIMEOUT_MS = 60_000;
const DEFAULT_CI_ANALYZE_TIMEOUT_MS = 180_000;

const command = process.argv[2] ?? 'check';

try {
  if (command === 'bootstrap') {
    runBootstrap();
  } else if (command === 'local') {
    runGitNexusContract({ mode: 'local' });
  } else if (command === 'gitnexus') {
    runGitNexusContract({ mode: 'ci' });
  } else if (command === 'check') {
    runGitNexusContract({ mode: process.env.CI ? 'ci' : 'local' });
  } else {
    throw new Error(`unknown contract command: ${command}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

function runBootstrap() {
  execFileSync('node', ['scripts/workflows/install-hooks.mjs'], { stdio: 'inherit' });
  console.log('Agent bootstrap complete.');
  console.log('- Before editing code: run npm run quality:predev');
  console.log('- Before committing code: run npm run quality:precommit');
  console.log('- Before pushing or submitting code: run npm run quality:local');
  console.log('- For critical skeleton changes: read GitNexus detect_changes/query/context/impact output');
  console.log('- Local git hooks run quality gates; CI remains the final contract gate.');
}

function runGitNexusContract({ mode }) {
  runGitNexusAnalyze(mode);

  const changedFiles = getChangedFiles(mode);
  const impactSummary = getImpactSummary();
  const result = evaluateGitNexusContract({ changedFiles, impactSummary });

  printContractResult('GitNexus contract', result);
  if (!result.ok) process.exitCode = 1;
}

function getChangedFiles(mode) {
  if (process.env.CONTRACT_CHANGED_FILES) {
    return process.env.CONTRACT_CHANGED_FILES.split(/\r?\n|,/).map((file) => file.trim()).filter(Boolean);
  }
  if (mode === 'ci' && process.env.GITHUB_BASE_REF) {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', process.env.GITHUB_BASE_REF], {
      stdio: 'inherit',
    });
    return gitLines(['diff', '--name-only', `--diff-filter=${CONTRACT_DIFF_FILTER}`, `origin/${process.env.GITHUB_BASE_REF}...HEAD`]);
  }
  return combineChangedFiles(
    gitLines(['diff', '--name-only', `--diff-filter=${CONTRACT_DIFF_FILTER}`, 'HEAD']),
    gitLines(['ls-files', '--others', '--exclude-standard']),
  );
}

function getImpactSummary() {
  if (process.env.GITNEXUS_IMPACT_SUMMARY) {
    return extractImpactSummary(process.env.GITNEXUS_IMPACT_SUMMARY);
  }
  if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return extractImpactSummary(event.pull_request?.body ?? '');
  }
  return '';
}

function runGitNexusAnalyze(mode) {
  const timeoutMs = resolveGitNexusAnalyzeTimeoutMs(mode);
  console.log(
    `Running GitNexus ${GITNEXUS_VERSION} analyze --force --index-only (${mode}, timeout ${timeoutMs}ms)...`,
  );
  try {
    execFileSync('npx', ['--yes', `gitnexus@${GITNEXUS_VERSION}`, 'analyze', '--force', '--index-only'], {
      stdio: 'inherit',
      timeout: timeoutMs,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(
        `GitNexus analyze timed out after ${timeoutMs}ms. Set GITNEXUS_ANALYZE_TIMEOUT_MS to a larger positive integer if this repo needs more time.`,
      );
    }
    throw err;
  }
}

function resolveGitNexusAnalyzeTimeoutMs(mode) {
  const configured = process.env.GITNEXUS_ANALYZE_TIMEOUT_MS;
  if (!configured) return mode === 'ci' ? DEFAULT_CI_ANALYZE_TIMEOUT_MS : DEFAULT_LOCAL_ANALYZE_TIMEOUT_MS;

  const timeoutMs = Number(configured);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('GITNEXUS_ANALYZE_TIMEOUT_MS must be a positive number of milliseconds.');
  }
  return Math.trunc(timeoutMs);
}

function isTimeoutError(err) {
  return err instanceof Error && (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT');
}

function gitLines(args) {
  const output = execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function printContractResult(title, result) {
  console.log(`\n${title}: ${result.ok ? 'passed' : 'failed'}`);
  for (const reason of result.reasons ?? []) console.log(`- ${reason}`);
  for (const warning of result.warnings ?? []) console.log(`- warning: ${warning}`);
  if (result.critical?.length) {
    console.log('Critical contract files:');
    for (const item of result.critical) console.log(`- ${item.category}: ${item.file}`);
  }
  if (result.suggestions?.length) {
    console.log('GitNexus suggestions:');
    for (const suggestion of result.suggestions) console.log(`- ${suggestion}`);
  }
}
