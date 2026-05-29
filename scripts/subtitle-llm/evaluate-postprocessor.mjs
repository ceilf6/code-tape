#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoSecrets, parseJsonObject } from './schema.mjs';

const EXPECTED_NEGATIVE_ISSUES = [
  'duplicate-segment',
  'invalid-chapter-timeline',
  'invalid-json',
  'unknown-segment',
];

async function main() {
  const [fixturePath] = process.argv.slice(2);
  if (!fixturePath) throw new Error('Usage: evaluate-postprocessor <fixture.json>');

  const fixture = parseJsonObject(await readFile(fixturePath, 'utf8'), fixturePath);
  const metrics = evaluatePostprocessorFixtures(fixture);
  console.log(JSON.stringify(metrics, null, 2));
  assertPostprocessorEvaluationGate(metrics);
}

export function evaluatePostprocessorFixtures(fixture) {
  const start = performance.now();
  assertNoSecrets(fixture);
  if (!isPlainObject(fixture) || !Array.isArray(fixture.samples)) {
    throw new Error('postprocessor evaluation fixture must contain samples');
  }

  const results = fixture.samples.map(evaluateSample);
  const representativeResults = results.filter((result) => result.kind === 'representative');
  const negativeResults = results.filter((result) => result.kind === 'negative');
  const representativeFailures = representativeResults.filter((result) => !result.passed);
  const negativeFailures = negativeResults.filter((result) => !result.expectedIssueDetected);
  const fixtureValidationDurations = results.map(
    (result) => result.fixtureValidationDurationMs,
  );
  const detectedNegativeIssues = [
    ...new Set(negativeResults.flatMap((result) => result.issues)),
  ].sort();

  return {
    samples: results.length,
    representativeSamples: representativeResults.length,
    negativeSamples: negativeResults.length,
    representativePassRate: ratio(
      representativeResults.length - representativeFailures.length,
      representativeResults.length,
    ),
    representativeJsonValidRate: ratio(
      representativeResults.filter((result) => !result.issues.includes('invalid-json')).length,
      representativeResults.length,
    ),
    representativeSegmentReferenceValidRate: ratio(
      representativeResults.filter(hasValidSegmentReferences).length,
      representativeResults.length,
    ),
    representativeCorrectionHitRate: ratio(
      sum(representativeResults, 'correctionHits'),
      sum(representativeResults, 'correctionExpectations'),
    ),
    representativeTermHitRate: ratio(
      sum(representativeResults, 'termHits'),
      sum(representativeResults, 'termExpectations'),
    ),
    representativeChapterTimelineValidRate: ratio(
      representativeResults.filter((result) => !result.issues.includes('invalid-chapter-timeline')).length,
      representativeResults.length,
    ),
    representativeChapterTitleHitRate: ratio(
      sum(representativeResults, 'chapterTitleHits'),
      sum(representativeResults, 'chapterTitleExpectations'),
    ),
    overallEvaluationDurationMs: round(performance.now() - start),
    averageFixtureValidationDurationMs: round(average(fixtureValidationDurations)),
    maxFixtureValidationDurationMs: round(Math.max(0, ...fixtureValidationDurations)),
    detectedNegativeIssues,
    failures: [
      ...representativeFailures.map((result) => ({
        id: result.id,
        issues: result.issues,
        missingCorrections: result.missingCorrections,
        missingTerms: result.missingTerms,
        missingChapterTitles: result.missingChapterTitles,
      })),
      ...negativeFailures.map((result) => ({
        id: result.id,
        issues: result.issues,
        expectedIssue: result.expectedIssue,
      })),
    ],
    sampleResults: results.map((result) => ({
      id: result.id,
      kind: result.kind,
      passed: result.passed,
      fixtureValidationDurationMs: result.fixtureValidationDurationMs,
      issues: result.issues,
      ...(result.expectedIssue ? { expectedIssue: result.expectedIssue } : {}),
      ...(result.expectedIssueDetected !== undefined
        ? { expectedIssueDetected: result.expectedIssueDetected }
        : {}),
    })),
  };
}

export function assertPostprocessorEvaluationGate(metrics) {
  const failures = [];
  if (metrics.representativeSamples < 3) {
    failures.push(`representativeSamples ${metrics.representativeSamples} < 3`);
  }
  if (metrics.representativePassRate < 1) {
    failures.push(`representativePassRate ${metrics.representativePassRate} < 1`);
  }
  for (const issue of EXPECTED_NEGATIVE_ISSUES) {
    if (!metrics.detectedNegativeIssues.includes(issue)) {
      failures.push(`negative fixture did not expose ${issue}`);
    }
  }
  if (metrics.failures.length > 0) {
    failures.push(`fixture failures: ${metrics.failures.map((failure) => failure.id).join(', ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`subtitle postprocessor evaluation gate failed: ${failures.join('; ')}`);
  }
}

function evaluateSample(sample) {
  const start = performance.now();
  const issues = [];
  const parsedOutput = parseOutput(sample.output, issues);
  const inputSegments = readInputSegments(sample, issues);
  const segmentAnalysis = analyzeSegments(inputSegments, parsedOutput, issues);
  const chapterAnalysis = analyzeChapters(sample, parsedOutput, issues);
  const expected = isPlainObject(sample.expect) ? sample.expect : {};
  const finalText = buildFinalText(inputSegments, segmentAnalysis.correctionsById);
  const correctionAnalysis = analyzeExpectedCorrections(expected, segmentAnalysis.correctionsById);
  const termAnalysis = analyzeExpectedTerms(expected, finalText);
  const chapterTitleAnalysis = analyzeExpectedChapterTitles(expected, chapterAnalysis.titles);
  const kind = sample.kind === 'negative' ? 'negative' : 'representative';
  const expectedIssue = kind === 'negative' && typeof expected.issue === 'string' ? expected.issue : undefined;
  const expectedIssueDetected = expectedIssue ? issues.includes(expectedIssue) : undefined;
  const passed =
    kind === 'representative'
      ? issues.length === 0 &&
        correctionAnalysis.missingCorrections.length === 0 &&
        termAnalysis.missingTerms.length === 0 &&
        chapterTitleAnalysis.missingChapterTitles.length === 0
      : Boolean(expectedIssueDetected);

  return {
    id: typeof sample.id === 'string' ? sample.id : '(missing id)',
    kind,
    passed,
    issues: [...new Set(issues)].sort(),
    expectedIssue,
    expectedIssueDetected,
    correctionHits: correctionAnalysis.hits,
    correctionExpectations: correctionAnalysis.total,
    missingCorrections: correctionAnalysis.missingCorrections,
    termHits: termAnalysis.hits,
    termExpectations: termAnalysis.total,
    missingTerms: termAnalysis.missingTerms,
    chapterTitleHits: chapterTitleAnalysis.hits,
    chapterTitleExpectations: chapterTitleAnalysis.total,
    missingChapterTitles: chapterTitleAnalysis.missingChapterTitles,
    fixtureValidationDurationMs: round(performance.now() - start),
  };
}

function parseOutput(output, issues) {
  if (typeof output !== 'string') {
    issues.push('invalid-json');
    return undefined;
  }
  try {
    const parsedOutput = parseJsonObject(output, 'postprocessor output');
    if (!isPlainObject(parsedOutput)) issues.push('invalid-json');
    return parsedOutput;
  } catch {
    issues.push('invalid-json');
    return undefined;
  }
}

function readInputSegments(sample, issues) {
  const inputSegments = sample.input?.segments;
  if (!Array.isArray(inputSegments) || inputSegments.length === 0) {
    issues.push('invalid-input');
    return [];
  }
  return inputSegments;
}

function analyzeSegments(inputSegments, output, issues) {
  const correctionsById = new Map();
  const inputIds = new Set(inputSegments.map((segment) => segment.id));
  const seenIds = new Set();

  if (output === undefined) return { correctionsById };
  if (!isPlainObject(output) || !Array.isArray(output.segments)) {
    issues.push('missing-segments');
    return { correctionsById };
  }

  for (const segment of output.segments) {
    if (!isPlainObject(segment) || typeof segment.id !== 'string') {
      issues.push('invalid-segment');
      continue;
    }
    if (!inputIds.has(segment.id)) {
      issues.push('unknown-segment');
      continue;
    }
    if (seenIds.has(segment.id)) {
      issues.push('duplicate-segment');
      continue;
    }
    seenIds.add(segment.id);
    if (typeof segment.text !== 'string' || segment.text.trim().length === 0) {
      issues.push('empty-segment-text');
      continue;
    }
    correctionsById.set(segment.id, segment.text.trim());
  }
  return { correctionsById };
}

function analyzeChapters(sample, output, issues) {
  const titles = [];
  if (output === undefined) return { titles };
  if (!isPlainObject(output) || !Array.isArray(output.chapters)) {
    issues.push('missing-chapters');
    return { titles };
  }

  const durationMs = readDurationMs(sample);
  let previousEndMs = -Infinity;
  for (let index = 0; index < output.chapters.length; index += 1) {
    const chapter = output.chapters[index];
    if (!isPlainObject(chapter) || typeof chapter.title !== 'string' || chapter.title.trim().length === 0) {
      issues.push('invalid-chapter');
      continue;
    }
    titles.push(chapter.title.trim());
    const startMs = chapter.startMs;
    const nextStartMs = output.chapters[index + 1]?.startMs ?? durationMs;
    const endMs = chapter.endMs ?? nextStartMs;
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      startMs > durationMs ||
      startMs < previousEndMs ||
      endMs <= startMs ||
      endMs > durationMs ||
      endMs > nextStartMs
    ) {
      issues.push('invalid-chapter-timeline');
      continue;
    }
    previousEndMs = endMs;
  }
  return { titles };
}

function analyzeExpectedCorrections(expected, correctionsById) {
  const corrections = Array.isArray(expected.corrections) ? expected.corrections : [];
  const missingCorrections = corrections.filter(
    (correction) => correctionsById.get(correction.id) !== correction.text,
  );
  return {
    hits: corrections.length - missingCorrections.length,
    total: corrections.length,
    missingCorrections,
  };
}

function analyzeExpectedTerms(expected, finalText) {
  const terms = Array.isArray(expected.terms) ? expected.terms : [];
  const missingTerms = terms.filter((term) => !finalText.includes(term));
  return {
    hits: terms.length - missingTerms.length,
    total: terms.length,
    missingTerms,
  };
}

function analyzeExpectedChapterTitles(expected, titles) {
  const chapterTitles = Array.isArray(expected.chapterTitles) ? expected.chapterTitles : [];
  const missingChapterTitles = chapterTitles.filter((title) => !titles.includes(title));
  return {
    hits: chapterTitles.length - missingChapterTitles.length,
    total: chapterTitles.length,
    missingChapterTitles,
  };
}

function buildFinalText(inputSegments, correctionsById) {
  return inputSegments.map((segment) => correctionsById.get(segment.id) ?? segment.text).join('\n');
}

function readDurationMs(sample) {
  if (Number.isFinite(sample.input?.durationMs)) return sample.input.durationMs;
  return Math.max(0, ...readInputSegments(sample, []).map((segment) => segment.endMs));
}

function hasValidSegmentReferences(result) {
  return !result.issues.some((issue) =>
    ['duplicate-segment', 'empty-segment-text', 'invalid-segment', 'missing-segments', 'unknown-segment'].includes(
      issue,
    ),
  );
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values, property) {
  return values.reduce((total, value) => total + value[property], 0);
}

function ratio(value, total) {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

function round(value) {
  return Number(value.toFixed(4));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
