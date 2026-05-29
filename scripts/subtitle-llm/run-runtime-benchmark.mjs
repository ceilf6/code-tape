import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
  npmCommand,
  [
    'run',
    'test',
    '-w',
    'apps/web',
    '--',
    'src/features/subtitles/__tests__/subtitlePostProcessorRuntimeBenchmark.test.tsx',
  ],
  {
    env: { ...process.env, SUBTITLE_RUNTIME_BENCHMARK: '1' },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

if (result.signal) {
  console.error(`Runtime benchmark stopped by signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
