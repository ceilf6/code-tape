import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('format shortcut contract keeps docs and capture mapping aligned', () => {
  const techPlan = readFileSync('docs/技术方案.md', 'utf8');
  const shortcutProducer = readFileSync('apps/web/src/features/capture/shortcutProducer.ts', 'utf8');

  assert.match(techPlan, /`Ctrl\/Cmd \+ S`：格式化。/u);
  assert.doesNotMatch(techPlan, /`Ctrl\/Cmd \+ S`：保存。/u);
  assert.match(shortcutProducer, /"Cmd\+S": \{ label: "Format", command: "format" \}/u);
  assert.match(shortcutProducer, /"Ctrl\+S": \{ label: "Format", command: "format" \}/u);
  assert.doesNotMatch(shortcutProducer, /"Cmd\+S": \{ label: "Save", command: "save" \}/u);
  assert.doesNotMatch(shortcutProducer, /"Ctrl\+S": \{ label: "Save", command: "save" \}/u);
});
