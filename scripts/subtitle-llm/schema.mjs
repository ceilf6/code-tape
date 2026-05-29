const SECRET_PATTERNS = [
  /\bhf_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/u,
];

export function validateSubtitleDistillationExample(value) {
  assertNoSecrets(value);
  if (!isPlainObject(value)) throw new Error('distillation example must be an object');
  if (!isNonEmptyString(value.id)) throw new Error('distillation example id is required');
  if (!Array.isArray(value.segments) || value.segments.length === 0) {
    throw new Error('distillation example segments are required');
  }
  const seenSegmentIds = new Set();
  let previousEndMs = -Infinity;
  value.segments.forEach((segment, index) => {
    validateInputSegment(segment, index);
    if (segment.startMs < previousEndMs) {
      throw new Error('segments must be ordered and non-overlapping');
    }
    if (seenSegmentIds.has(segment.id)) {
      throw new Error(`duplicate segment id: ${segment.id}`);
    }
    seenSegmentIds.add(segment.id);
    previousEndMs = segment.endMs;
  });
  if (value.context !== undefined && !isPlainObject(value.context)) {
    throw new Error('distillation example context must be an object');
  }
  return value;
}

export function validateSubtitleTeacherResult(value, example) {
  assertNoSecrets(value);
  const normalizedExample = validateSubtitleDistillationExample(example);
  if (!isPlainObject(value)) throw new Error('teacher result must be an object');
  if (!Array.isArray(value.segments)) throw new Error('teacher result segments are required');
  if (!Array.isArray(value.chapters)) throw new Error('teacher result chapters are required');
  if (value.chapters.length === 0) throw new Error('chapters must contain at least one chapter');

  const inputIds = new Set(normalizedExample.segments.map((segment) => segment.id));
  const seenIds = new Set();
  for (const [index, segment] of value.segments.entries()) {
    if (!isPlainObject(segment)) throw new Error(`teacher result segments[${index}] must be an object`);
    if (!isNonEmptyString(segment.id)) throw new Error(`teacher result segments[${index}].id is required`);
    if (!isNonEmptyString(segment.text)) throw new Error(`teacher result segments[${index}].text is required`);
    if (!inputIds.has(segment.id)) throw new Error(`teacher result references unknown segment: ${segment.id}`);
    if (seenIds.has(segment.id)) throw new Error(`teacher result repeats segment: ${segment.id}`);
    seenIds.add(segment.id);
  }

  validateTeacherChapters(value.chapters, {
    startMs: normalizedExample.segments[0].startMs,
    endMs: normalizedExample.segments[normalizedExample.segments.length - 1].endMs,
  });
  return value;
}

export function buildDistillationMessages(example) {
  const normalizedExample = validateSubtitleDistillationExample(example);
  return [
    {
      role: 'system',
      content: [
        'You are the code-tape subtitle post-processing model.',
        'Goal: correct ASR subtitle text for frontend/code terms and create playback chapter jump points.',
        'Input subtitle rows with timing are in inputSegments.',
        'Only output JSON with segments and chapters. Do not output Markdown or explanations. 只输出 JSON。',
        'For speed, output only changed subtitle segments in segments. Omit unchanged segments.',
        'Each returned segment must contain only id and text.',
        'Generate short playback chapter jump points from subtitle content and timestamps.',
        'Output shape example: {"segments":[{"id":"subtitle-1","text":"这里用 useState 维护 count"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        context: normalizedExample.context ?? {},
        inputSegments: normalizedExample.segments.map((segment) => ({
          id: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
        })),
      }),
    },
  ];
}

export function buildTrainingRecord({ example, teacherResult, teacherModel }) {
  const normalizedTeacherResult = validateSubtitleTeacherResult(teacherResult, example);
  return {
    messages: [
      ...buildDistillationMessages(example),
      {
        role: 'assistant',
        content: JSON.stringify(normalizedTeacherResult),
      },
    ],
    metadata: {
      id: example.id,
      teacherModel,
      inputSegmentIds: example.segments.map((segment) => segment.id),
    },
  };
}

export function validateSubtitleTrainingRecord(value) {
  assertNoSecrets(value);
  if (!isPlainObject(value)) throw new Error('training record must be an object');
  if (!Array.isArray(value.messages) || value.messages.length !== 3) {
    throw new Error('training record messages must contain system, user, and assistant turns');
  }
  const [system, user, assistant] = value.messages;
  validateMessage(system, 'system', 0);
  validateMessage(user, 'user', 1);
  validateMessage(assistant, 'assistant', 2);
  const userPayload = parseJsonObject(user.content, 'user training content');
  const teacherResult = parseJsonObject(assistant.content, 'assistant training content');
  validateSubtitleTeacherResult(teacherResult, {
    id: value.metadata?.id ?? 'training-record',
    language: userPayload.language,
    context: userPayload.context,
    segments: readPromptSegments(userPayload),
  });
  return value;
}

export function parseJsonObject(text, label = 'JSON') {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

function validateMessage(message, role, index) {
  if (!isPlainObject(message)) throw new Error(`messages[${index}] must be an object`);
  if (message.role !== role) throw new Error(`messages[${index}].role must be ${role}`);
  if (!isNonEmptyString(message.content)) throw new Error(`messages[${index}].content is required`);
}

export function assertNoSecrets(value, path = '$') {
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) throw new Error(`secret-like value found at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function validateInputSegment(segment, index) {
  if (!isPlainObject(segment)) throw new Error(`segments[${index}] must be an object`);
  if (!isNonEmptyString(segment.id)) throw new Error(`segments[${index}].id is required`);
  if (!Number.isFinite(segment.startMs)) throw new Error(`segments[${index}].startMs is required`);
  if (!Number.isFinite(segment.endMs)) throw new Error(`segments[${index}].endMs is required`);
  if (segment.endMs <= segment.startMs) throw new Error(`segments[${index}] endMs must be after startMs`);
  if (!isNonEmptyString(segment.text)) throw new Error(`segments[${index}].text is required`);
}

function validateTeacherChapter(chapter, index) {
  if (!isPlainObject(chapter)) throw new Error(`chapters[${index}] must be an object`);
  if (!isNonEmptyString(chapter.title)) throw new Error(`chapters[${index}].title is required`);
  if (!Number.isFinite(chapter.startMs)) throw new Error(`chapters[${index}].startMs is required`);
  if (chapter.startMs < 0) throw new Error(`chapters[${index}].startMs must be non-negative`);
  if (chapter.endMs !== undefined && !Number.isFinite(chapter.endMs)) {
    throw new Error(`chapters[${index}].endMs must be a number when present`);
  }
  if (chapter.endMs !== undefined && chapter.endMs <= chapter.startMs) {
    throw new Error(`chapters[${index}].endMs must be after startMs`);
  }
}

function validateTeacherChapters(chapters, timeline) {
  let previousEndMs = -Infinity;
  chapters.forEach((chapter, index) => {
    validateTeacherChapter(chapter, index);
    if (chapter.startMs < timeline.startMs || chapter.startMs > timeline.endMs) {
      throw new Error('chapters must stay within the source subtitle timeline');
    }
    if (chapter.endMs !== undefined && chapter.endMs > timeline.endMs) {
      throw new Error('chapters must stay within the source subtitle timeline');
    }
    if (chapter.startMs < previousEndMs) {
      throw new Error('chapters must be ordered and non-overlapping');
    }
    previousEndMs = chapter.endMs ?? chapter.startMs;
  });
}

export function readPromptSegments(payload) {
  if (Array.isArray(payload.inputSegments) && Array.isArray(payload.timeline)) {
    const timelineById = new Map(payload.timeline.map((item) => [item.id, item]));
    return payload.inputSegments.map((segment) => {
      if (!isPlainObject(segment)) return segment;
      return {
        ...segment,
        startMs: timelineById.get(segment.id)?.startMs,
        endMs: timelineById.get(segment.id)?.endMs,
      };
    });
  }
  return payload.inputSegments ?? payload.segments;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
