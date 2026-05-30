import { beforeEach, describe, expect, it, vi } from "vitest";

const transformersMock = vi.hoisted(() => ({
  env: {
    useBrowserCache: true,
    useCustomCache: false,
    customCache: null as null | {
      match(cacheKey: string): Promise<Response | undefined>;
      put(cacheKey: string, response: Response): Promise<void>;
    },
    cacheKey: "transformers-cache",
  },
  pipeline: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => transformersMock);

import {
  buildSubtitlePostProcessorMessages,
  buildSubtitlePostProcessorPrompt,
  createHuggingFaceSubtitlePostProcessor,
  extractSubtitleCorrectionResult,
} from "../subtitlePostProcessor";
import type { SubtitleTrack } from "../types";

function makeTrack(): SubtitleTrack {
  return {
    recordingId: "recording-1",
    generatedAt: "2026-05-28T00:00:00.000Z",
    model: "onnx-community/whisper-tiny",
    source: "huggingface-local",
    language: "zh",
    segments: [
      { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
      { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "render result" },
    ],
  };
}

function makeTrackWithSegments(segmentCount: number): SubtitleTrack {
  return {
    ...makeTrack(),
    segments: Array.from({ length: segmentCount }, (_, index) => ({
      id: `subtitle-${index + 1}`,
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
      text: `segment ${index + 1}`,
    })),
  };
}

function readUserPayloadFromMessages(messages: unknown): {
  code: string;
  runtimeOutput: string;
} {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const userMessage = messages.find(
    (message): message is { role: string; content: string } =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      "content" in message &&
      message.role === "user" &&
      typeof message.content === "string",
  );
  if (!userMessage) throw new Error("messages are missing a user message");
  const payload = JSON.parse(userMessage.content) as {
    context?: { code?: string; runtimeOutput?: string };
  };
  return {
    code: payload.context?.code ?? "",
    runtimeOutput: payload.context?.runtimeOutput ?? "",
  };
}

function readPostProcessorPayload(messages: unknown): {
  inputSegments: Array<{ id: string; startMs: number; endMs: number; text: string }>;
  timeline?: unknown;
} {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const userMessage = messages.find(
    (message): message is { role: string; content: string } =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      "content" in message &&
      message.role === "user" &&
      typeof message.content === "string",
  );
  if (!userMessage) throw new Error("missing user message");
  return JSON.parse(userMessage.content) as {
    inputSegments: Array<{ id: string; startMs: number; endMs: number; text: string }>;
    timeline?: unknown;
  };
}

describe("createHuggingFaceSubtitlePostProcessor", () => {
  beforeEach(() => {
    transformersMock.env.useBrowserCache = true;
    transformersMock.env.useCustomCache = false;
    transformersMock.env.customCache = null;
    transformersMock.env.cacheKey = "transformers-cache";
    transformersMock.pipeline.mockReset();
  });

  it("builds chat-template messages and parses strict JSON output", async () => {
    const pipeline = vi.fn(async (_prompt: unknown, _options: unknown) => [
      {
        generated_text:
          '```json\n{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"问题分析","startMs":0,"endMs":1000}]}\n```',
      },
    ]);
    const pipelineFactory = vi.fn(async () => pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    const result = await postProcessor.process({
      track: makeTrack(),
      context: {
        language: "tsx",
        fileName: "Counter.tsx",
        code: "const [count, setCount] = useState(0);",
        runtimeOutput: "ReferenceError: count is not defined",
        glossary: ["useState", "React", "code-tape"],
      },
    });

    expect(pipelineFactory).toHaveBeenCalledWith(
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "wasm", dtype: "q8" },
    );
    const promptMessages = pipeline.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(promptMessages).toEqual([
      {
        role: "system",
        content: expect.stringContaining("只输出 JSON"),
      },
      {
        role: "user",
        content: expect.stringContaining("Counter.tsx"),
      },
    ]);
    expect(pipeline).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ do_sample: false, repetition_penalty: 1.05, return_full_text: false }),
    );
    expect(JSON.stringify(promptMessages)).toContain("use state hook");
    expect(JSON.stringify(promptMessages)).toContain("inputSegments");
    expect(JSON.stringify(promptMessages)).not.toContain('"language"');
    const payload = JSON.parse(promptMessages[1]?.content ?? "{}") as {
      inputSegments?: unknown;
      timeline?: unknown;
      segments?: unknown;
    };
    expect(payload).not.toHaveProperty("segments");
    expect(payload).not.toHaveProperty("timeline");
    expect(payload.inputSegments).toContainEqual({
      id: "subtitle-1",
      startMs: 0,
      endMs: 1_000,
      text: "use state hook",
    });
    expect(JSON.stringify(payload).match(/subtitle-1/gu)).toHaveLength(1);
    expect(result).toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "问题分析", startMs: 0, endMs: 1_000 }],
    });
  });

  it("retries once with a JSON repair prompt when the local LLM omits a JSON object", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ generated_text: "Sure, here is the corrected subtitle." }])
      .mockResolvedValueOnce([
        {
          generated_text:
            '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
        },
      ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(pipeline.mock.calls[1]?.[0])).toContain("Regenerate from scratch");
  });

  it("rejects invalid LLM output after the retry instead of saving fallback chapters", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ generated_text: '{"segments":[{"id":"subtitle-1","text":"今天我们来做红烧肉"}]' }])
      .mockResolvedValueOnce([{ generated_text: "Still not JSON" }]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "今天我们来做红烧肉" },
            { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "先把五花肉切块" },
          ],
        },
      }),
    ).rejects.toThrow(/JSON/);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("retries when the local LLM omits required chapters instead of applying fallback chapters", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([
        {
          generated_text: [
            { role: "user", content: "input subtitle payload" },
            {
              role: "assistant",
              content:
                '{"segments":[{"id":"subtitle-1","text":"useState hook"}]} {"timeline":[{"id":"subtitle-1","startMs":0,"endMs":1000}]}',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          generated_text: [
          { role: "user", content: "input subtitle payload" },
          {
            role: "assistant",
            content:
              '{"segments":[{"id":"subtitle-1","text":"useState hook"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
          },
          ],
        },
      ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("retries loose title-only output instead of treating missing chapters as success", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([
        {
          generated_text:
            '{"segments":[],"titles":[{"id":"subtitle-1","text":"first title"},{"id":"subtitle-1","text":"duplicate title"},{"id":"subtitle-2","text":"second title"}]}',
        },
      ])
      .mockResolvedValueOnce([
        {
          generated_text:
            '{"segments":[],"chapters":[{"title":"片段 1","startMs":0,"endMs":1000},{"title":"片段 2","startMs":1000,"endMs":3000}]}',
        },
      ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [],
      chapters: [
        { title: "片段 1", startMs: 0, endMs: 1_000 },
        { title: "片段 2", startMs: 1_000, endMs: 3_000 },
      ],
    });
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it("deduplicates loose chapters that repeat the same timeline", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[],"chapters":[{"title":"片段 1","startMs":0,"endMs":1000},{"title":"重复片段","startMs":0,"endMs":1000},{"title":"片段 2","startMs":1000,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [],
      chapters: [
        { title: "片段 1", startMs: 0, endMs: 1_000 },
        { title: "片段 2", startMs: 1_000, endMs: 3_000 },
      ],
    });
  });

  it("does not synthesize generic fallback chapters for non-technical invalid output", async () => {
    const pipeline = vi
      .fn()
      .mockResolvedValueOnce([{ generated_text: '{"segments":[{"id":"subtitle-1","text":"今天我们来做红烧肉"}]' }])
      .mockResolvedValueOnce([{ generated_text: "Still not JSON" }]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "今天我们来做红烧肉" },
            { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "先把五花肉切块" },
          ],
        },
      }),
    ).rejects.toThrow(/JSON/);
  });

  it("parses Transformers.js chat message arrays nested inside generated_text", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text: [
          { role: "user", content: "input subtitle payload" },
          {
            role: "assistant",
            content:
              '{"segments":[{"id":"subtitle-1","text":"useState hook"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
          },
        ],
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
  });

  it("drops invented chapters that start after the final input subtitle", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000},{"title":"模型幻觉章节","startMs":3000,"endMs":4000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    });
  });

  it("drops overlapping chapters after ordering them by start time", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[],"chapters":[{"title":"后半段","startMs":3000,"endMs":4000},{"title":"前半段","startMs":0,"endMs":2000},{"title":"重叠段","startMs":1000,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrackWithSegments(4) })).resolves.toEqual({
      segments: [],
      chapters: [
        { title: "前半段", startMs: 0, endMs: 2_000 },
        { title: "后半段", startMs: 3_000, endMs: 4_000 },
      ],
    });
  });

  it("drops unknown and repeated correction segment ids before returning the model result", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"},{"id":"subtitle-2","text":"duplicated render result"},{"id":"subtitle-3","text":"invented segment"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
  });

  it("records debug reasons when sparse subtitle corrections are dropped", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-404","text":"invented segment"},{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-1","text":"duplicate"},{"id":"subtitle-2","text":"chapter jump point"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    try {
      await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
        segments: [{ id: "subtitle-1", text: "useState hook" }],
        chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
      });
      expect(debug).toHaveBeenCalledWith(
        "[code-tape] dropped subtitle correction",
        expect.objectContaining({ reason: "unknown-segment", segmentId: "subtitle-404" }),
      );
      expect(debug).toHaveBeenCalledWith(
        "[code-tape] dropped subtitle correction",
        expect.objectContaining({ reason: "duplicate-segment", segmentId: "subtitle-1" }),
      );
      expect(debug).toHaveBeenCalledWith(
        "[code-tape] dropped subtitle correction",
        expect.objectContaining({ reason: "implausible-text", segmentId: "subtitle-2" }),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it("drops hallucinated sparse corrections that do not preserve source code terms", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"chapter jump point"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
    });
  });

  it("drops corrections that rewrite short hook phrases into a different code term", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"使用 useLocales 时钟清理 worker"}],"chapters":[{"title":"副作用清理","startMs":0,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({
      track: {
        ...makeTrack(),
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "use state hook" },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "use effect 里面清理 worker" },
        ],
      },
    })).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "副作用清理", startMs: 0, endMs: 3_000 }],
    });
  });

  it("keeps near-match corrections that fuse ASR words into frontend tool names", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"Playwright 跑端到端测试"},{"id":"subtitle-2","text":"Vitest 负责单元测试"}],"chapters":[{"title":"测试验证","startMs":0,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({
      track: {
        ...makeTrack(),
        segments: [
          { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "play right 跑端到端测试" },
          { id: "subtitle-2", startMs: 1_000, endMs: 3_000, text: "vit test 负责单元测试" },
        ],
      },
    })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "Playwright 跑端到端测试" },
        { id: "subtitle-2", text: "Vitest 负责单元测试" },
      ],
      chapters: [{ title: "测试验证", startMs: 0, endMs: 3_000 }],
    });
  });

  it("drops truncated corrections even when one source term is fused", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "先讲 use state，再看 render result" },
          ],
        },
      }),
    ).resolves.toEqual({
      segments: [],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    });
  });

  it("keeps single-term frontend typo corrections without requiring the misspelling to survive", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"render result"}],"chapters":[{"title":"渲染结果","startMs":0,"endMs":1000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "redner result" },
          ],
        },
      }),
    ).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "render result" }],
      chapters: [{ title: "渲染结果", startMs: 0, endMs: 1_000 }],
    });
  });

  it("allows four-term sparse corrections to drop one source term at the preservation boundary", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"alpha beta gamma 修正"}],"chapters":[{"title":"片段 1","startMs":0,"endMs":1000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "alpha beta gamma delta" },
          ],
        },
      }),
    ).resolves.toEqual({
      segments: [{ id: "subtitle-1", text: "alpha beta gamma 修正" }],
      chapters: [{ title: "片段 1", startMs: 0, endMs: 1_000 }],
    });
  });

  it("drops chapters with replacement-character quantization noise", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态�设计","startMs":0,"endMs":1000},{"title":"渲染结果","startMs":1000,"endMs":3000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "useState hook" },
        { id: "subtitle-2", text: "render result" },
      ],
      chapters: [{ title: "渲染结果", startMs: 1_000, endMs: 3_000 }],
    });
  });

  it("drops CJK corrections that only preserve repeated filler characters", async () => {
    const pipeline = vi.fn(async () => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"组件"}],"chapters":[{"title":"片段 1","startMs":0,"endMs":1000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: {
          ...makeTrack(),
          segments: [
            { id: "subtitle-1", startMs: 0, endMs: 1_000, text: "看看看看这个组件" },
          ],
        },
      }),
    ).resolves.toEqual({
      segments: [],
      chapters: [{ title: "片段 1", startMs: 0, endMs: 1_000 }],
    });
  });

  it("uses the validated WASM q8 path directly for the default ONNX model", async () => {
    const pipeline = vi.fn(async (_prompt: string, _options: unknown) => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const pipelineFactory = vi.fn().mockResolvedValueOnce(pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    const result = await postProcessor.process({ track: makeTrack() });

    expect(pipelineFactory).toHaveBeenNthCalledWith(
      1,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "wasm", dtype: "q8" },
    );
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(result.chapters).toEqual([{ title: "状态设计", startMs: 0, endMs: 3_000 }]);
  });

  it("uses the fine-tuned browser model as the default", async () => {
    const pipeline = vi.fn(async (_prompt: string, _options: unknown) => [
      {
        generated_text:
          '{"segments":[{"id":"subtitle-1","text":"useState hook"},{"id":"subtitle-2","text":"render result"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":3000}]}',
      },
    ]);
    const pipelineFactory = vi.fn().mockResolvedValueOnce(pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory,
    });

    await expect(postProcessor.process({ track: makeTrack() })).resolves.toEqual(
      expect.objectContaining({
        chapters: [{ title: "状态设计", startMs: 0, endMs: 3_000 }],
      }),
    );
    expect(pipelineFactory).toHaveBeenNthCalledWith(
      1,
      "text-generation",
      "ceilf6/code-tape-subtitle-postprocessor-onnx",
      { device: "wasm", dtype: "q8" },
    );
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it("uses a safer short-track generation budget for JSON chapters and sparse corrections", async () => {
    const pipeline = vi.fn(async (_prompt: unknown, _options: { max_new_tokens: number }) => [
      {
        generated_text:
          '{"segments":[],"chapters":[{"title":"片段 1","startMs":0,"endMs":5000}]}',
      },
    ]);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await postProcessor.process({ track: makeTrackWithSegments(5) });

    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeGreaterThanOrEqual(128);
  });

  it("wraps local LLM load failures with a user-facing browser capability error", async () => {
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => {
        throw new Error("WebAssembly memory allocation failed");
      }),
    });

    await expect(postProcessor.process({ track: makeTrack() })).rejects.toThrow(
      /当前浏览器无法加载本地字幕 LLM 模型/,
    );
  });

  it("uses a quiet custom cache when the browser Cache API rejects large model writes", async () => {
    const loadedPipeline = vi.fn();
    transformersMock.pipeline.mockResolvedValueOnce(loadedPipeline);
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new DOMException("Unexpected internal error.", "UnknownError");
      }),
    };
    const open = vi.fn(async () => cache);
    vi.stubGlobal("caches", { open });
    const postProcessor = createHuggingFaceSubtitlePostProcessor();

    await postProcessor.warmUp?.();

    expect(transformersMock.env.useCustomCache).toBe(true);
    expect(transformersMock.env.customCache).not.toBeNull();
    await expect(
      transformersMock.env.customCache?.put("model-cache-key", new Response("weights")),
    ).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("transformers-cache");
    expect(cache.put).toHaveBeenCalledWith("model-cache-key", expect.any(Response));
  });

  it("keeps the output budget bounded for a full single-window track", async () => {
    const track = makeTrackWithSegments(60);
    const pipeline = vi.fn(
      async (
        _prompt: unknown,
        _options: { max_new_tokens: number; do_sample: boolean; return_full_text: boolean },
      ) => [
        {
          generated_text: JSON.stringify({
            segments: track.segments.map((segment) => ({ id: segment.id, text: segment.text })),
            chapters: [],
          }),
        },
      ],
    );
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    const result = await postProcessor.process({ track });

    expect(pipeline).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ max_new_tokens: expect.any(Number) }),
    );
    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeGreaterThanOrEqual(128);
    expect(pipeline.mock.calls[0]?.[1]?.max_new_tokens).toBeLessThanOrEqual(1_024);
    expect(result.segments).toHaveLength(track.segments.length);
  });

  it("chunks medium subtitle tracks into 60 segment windows", async () => {
    for (const [segmentCount, expectedChunkSizes] of [
      [61, [60, 1]],
      [120, [60, 60]],
    ] as const) {
      const track = makeTrackWithSegments(segmentCount);
      const pipeline = vi.fn(async (messages: unknown) => {
        const payload = readPostProcessorPayload(messages);
        const firstSegment = payload.inputSegments[0];
        const lastSegment = payload.inputSegments.at(-1);
        if (!firstSegment || !lastSegment) throw new Error("empty chunk");
        return [
          {
            generated_text: JSON.stringify({
              segments: [{ id: firstSegment.id, text: `${firstSegment.text} corrected` }],
              chapters: [
                {
                  title: `窗口 ${pipeline.mock.calls.length}`,
                  startMs: firstSegment.startMs,
                  endMs: lastSegment.endMs,
                },
              ],
            }),
          },
        ];
      });
      const postProcessor = createHuggingFaceSubtitlePostProcessor({
        pipelineFactory: vi.fn(async () => pipeline),
      });

      const result = await postProcessor.process({ track });

      expect(pipeline.mock.calls.map((call) => readPostProcessorPayload(call[0]).inputSegments.length)).toEqual(
        expectedChunkSizes,
      );
      expect(result.segments.map((segment) => segment.id)).toEqual(
        expectedChunkSizes.map((_, index) => `subtitle-${index * 60 + 1}`),
      );
      expect(result.chapters?.map((chapter) => chapter.startMs)).toEqual(
        expectedChunkSizes.map((_, index) => index * 60_000),
      );
    }
  });

  it("chunks oversized subtitle tracks before calling the local LLM", async () => {
    const track = makeTrackWithSegments(121);
    const pipeline = vi.fn(async (messages: unknown) => {
      const payload = readPostProcessorPayload(messages);
      const firstSegment = payload.inputSegments[0];
      const lastSegment = payload.inputSegments.at(-1);
      if (!firstSegment || !lastSegment) throw new Error("empty chunk");
      expect(payload.timeline).toBeUndefined();
      return [
        {
          generated_text: JSON.stringify({
            segments: [{ id: firstSegment.id, text: `${firstSegment.text} corrected` }],
            chapters: [
              {
                title: `分块 ${pipeline.mock.calls.length}`,
                startMs: firstSegment.startMs,
                endMs: lastSegment.endMs,
              },
            ],
          }),
        },
      ];
    });
    const pipelineFactory = vi.fn(async () => pipeline);
    const postProcessor = createHuggingFaceSubtitlePostProcessor({ pipelineFactory });

    await expect(postProcessor.process({ track })).resolves.toEqual({
      segments: [
        { id: "subtitle-1", text: "segment 1 corrected" },
        { id: "subtitle-61", text: "segment 61 corrected" },
        { id: "subtitle-121", text: "segment 121 corrected" },
      ],
      chapters: [
        { title: "分块 1", startMs: 0, endMs: 60_000 },
        { title: "分块 2", startMs: 60_000, endMs: 120_000 },
        { title: "分块 3", startMs: 120_000, endMs: 121_000 },
      ],
    });
    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipeline).toHaveBeenCalledTimes(3);
    expect(pipeline.mock.calls.map((call) => readPostProcessorPayload(call[0]).inputSegments.length)).toEqual([
      60, 60, 1,
    ]);
    for (const call of pipeline.mock.calls) {
      const payload = readPostProcessorPayload(call[0]);
      expect(payload.inputSegments.length).toBeLessThanOrEqual(60);
      expect(payload.timeline).toBeUndefined();
    }
  });

  it("drops out-of-window and repeated corrections while chunking oversized tracks", async () => {
    const track = makeTrackWithSegments(121);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const pipeline = vi.fn(async (messages: unknown) => {
      const payload = readPostProcessorPayload(messages);
      const firstSegment = payload.inputSegments[0];
      const lastSegment = payload.inputSegments.at(-1);
      if (!firstSegment || !lastSegment) throw new Error("empty chunk");
      expect(payload.timeline).toBeUndefined();
      return [
        {
          generated_text: JSON.stringify({
            segments: [
              { id: firstSegment.id, text: `${firstSegment.text} corrected` },
              { id: firstSegment.id, text: `${firstSegment.text} duplicate` },
              { id: "subtitle-999", text: "invented segment" },
            ],
            chapters: [
              { title: "越界章节", startMs: lastSegment.endMs + 10_000, endMs: lastSegment.endMs + 12_000 },
              { title: "有效章节", startMs: firstSegment.startMs, endMs: lastSegment.endMs },
            ],
          }),
        },
      ];
    });
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    try {
      await expect(postProcessor.process({ track })).resolves.toEqual({
        segments: [
          { id: "subtitle-1", text: "segment 1 corrected" },
          { id: "subtitle-61", text: "segment 61 corrected" },
          { id: "subtitle-121", text: "segment 121 corrected" },
        ],
        chapters: [
          { title: "有效章节", startMs: 0, endMs: 60_000 },
          { title: "有效章节", startMs: 60_000, endMs: 120_000 },
          { title: "有效章节", startMs: 120_000, endMs: 121_000 },
        ],
      });
      expect(debug).toHaveBeenCalledWith(
        "[code-tape] dropped subtitle correction",
        expect.objectContaining({ reason: "duplicate-segment" }),
      );
      expect(debug).toHaveBeenCalledWith(
        "[code-tape] dropped subtitle correction",
        expect.objectContaining({ reason: "unknown-segment", segmentId: "subtitle-999" }),
      );
    } finally {
      debug.mockRestore();
    }
  });

  it("keeps merged chunk chapters ordered and scoped to each subtitle window", async () => {
    const track = makeTrackWithSegments(121);
    const pipeline = vi.fn(async (messages: unknown) => {
      const payload = readPostProcessorPayload(messages);
      const firstSegment = payload.inputSegments[0];
      const lastSegment = payload.inputSegments.at(-1);
      if (!firstSegment || !lastSegment) throw new Error("empty chunk");
      expect(payload.timeline).toBeUndefined();
      const callIndex = pipeline.mock.calls.length;
      const chapters =
        callIndex === 2
          ? [
              { title: "重复片段", startMs: 0, endMs: 10_000 },
              { title: "窗口前污染", startMs: 50_000, endMs: 55_000 },
              { title: "第二段", startMs: firstSegment.startMs, endMs: lastSegment.endMs },
            ]
          : [
              {
                title: `靠后 ${callIndex}`,
                startMs: firstSegment.startMs + 30_000,
                endMs: Math.min(firstSegment.startMs + 45_000, lastSegment.endMs),
              },
              { title: `靠前 ${callIndex}`, startMs: firstSegment.startMs, endMs: firstSegment.startMs + 10_000 },
            ];
      return [
        {
          generated_text: JSON.stringify({
            segments: [],
            chapters,
          }),
        },
      ];
    });
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(postProcessor.process({ track })).resolves.toEqual({
      segments: [],
      chapters: [
        { title: "靠前 1", startMs: 0, endMs: 10_000 },
        { title: "靠后 1", startMs: 30_000, endMs: 45_000 },
        { title: "第二段", startMs: 60_000, endMs: 120_000 },
        { title: "靠前 3", startMs: 120_000, endMs: 121_000 },
      ],
    });
    expect(pipeline).toHaveBeenCalledTimes(3);
  });

  it("stops chunked local LLM processing after aborting between oversized track windows", async () => {
    const abortController = new AbortController();
    const pipeline = vi.fn(async () => {
      abortController.abort();
      return [
        {
          generated_text:
            '{"segments":[{"id":"subtitle-1","text":"segment 1 corrected"}],"chapters":[{"title":"第一段","startMs":0,"endMs":60000}]}',
        },
      ];
    });
    const postProcessor = createHuggingFaceSubtitlePostProcessor({
      pipelineFactory: vi.fn(async () => pipeline),
    });

    await expect(
      postProcessor.process({
        track: makeTrackWithSegments(121),
        signal: abortController.signal,
      }),
    ).rejects.toThrow(/字幕纠错已取消/);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});

describe("buildSubtitlePostProcessorPrompt", () => {
  it("builds chat messages that match the fine-tuning conversation shape", () => {
    const messages = buildSubtitlePostProcessorMessages({
      track: makeTrack(),
      context: { glossary: ["TypeScript", "React"] },
    });

    expect(messages).toEqual([
      {
        role: "system",
        content: expect.stringContaining("只输出 JSON"),
      },
      {
        role: "user",
        content: expect.stringContaining("subtitle-1"),
      },
    ]);
  });

  it("builds retry messages as fresh repair instructions instead of an assistant continuation", () => {
    const messages = buildSubtitlePostProcessorMessages(
      { track: makeTrack() },
      {
        previousOutput:
          'prefix {"segments":[],"chapters":[{"title":"片段 1","startMs":0,"endMs":1000}]} suffix',
      },
    );

    expect(messages).toHaveLength(3);
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(messages[2]).toEqual({
      role: "user",
      content: expect.stringContaining("Regenerate from scratch"),
    });
    expect(messages[2]?.content).toContain('"segments":[]');
    expect(messages[2]?.content).not.toContain("suffix");
  });

  it("keeps the prompt scoped to subtitle correction and chapter generation", () => {
    const prompt = buildSubtitlePostProcessorPrompt({
      track: makeTrack(),
      context: { glossary: ["TypeScript", "React"] },
    });

    expect(prompt).toContain("只输出 JSON");
    expect(prompt).toContain("correct ASR subtitle text for frontend/code terms");
    expect(prompt).not.toContain("简体中文");
    expect(prompt).toContain("output only changed subtitle segments");
    expect(prompt).toContain("segments");
    expect(prompt).toContain("chapters");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("subtitle-1");
  });

  it("builds the exported prompt from the same production payload shape as chat messages", () => {
    const prompt = buildSubtitlePostProcessorPrompt({
      track: makeTrack(),
      context: { fileName: "Counter.tsx", glossary: ["TypeScript", "React"] },
    });

    expect(prompt).toContain('"context"');
    expect(prompt).toContain('"inputSegments"');
    expect(prompt).not.toContain('"timeline"');
    expect(prompt).toContain('"startMs"');
    expect(prompt).toContain('"endMs"');
    expect(prompt).not.toContain('"language"');
  });

  it("budgets large code and runtime context before building the local LLM messages", () => {
    const longCode = `const head = true;\n${"a".repeat(7_000)}\nconst tail = true;`;
    const longRuntimeOutput = `first error\n${"b".repeat(3_000)}\nlast error`;
    const messages = buildSubtitlePostProcessorMessages({
      track: makeTrack(),
      context: {
        code: longCode,
        runtimeOutput: longRuntimeOutput,
      },
    });
    const payload = readUserPayloadFromMessages(messages);

    expect(payload.code.length).toBeLessThan(longCode.length);
    expect(payload.code).toContain("[truncated");
    expect(payload.code).toContain("const head = true;");
    expect(payload.code).toContain("const tail = true;");
    expect(payload.runtimeOutput.length).toBeLessThan(longRuntimeOutput.length);
    expect(payload.runtimeOutput).toContain("[truncated");
    expect(payload.runtimeOutput).toContain("first error");
    expect(payload.runtimeOutput).toContain("last error");
  });
});

describe("extractSubtitleCorrectionResult", () => {
  it("rejects model output that omits chapters for the complete P1 plus mode", () => {
    expect(() =>
      extractSubtitleCorrectionResult('{"segments":[{"id":"subtitle-1","text":"useState hook"}]}'),
    ).toThrow(/chapters/);
  });

  it("rejects non-JSON model output", () => {
    expect(() => extractSubtitleCorrectionResult("Sure, here is the corrected subtitle.")).toThrow(
      /JSON/,
    );
  });

  it("parses the first complete JSON object when a small local model repeats trailing text", () => {
    expect(
      extractSubtitleCorrectionResult(
        '{"segments":[{"id":"subtitle-1","text":"useState hook"}],"chapters":[{"title":"状态设计","startMs":0,"endMs":1000}]} {"extra":"重复尾巴"}',
      ),
    ).toEqual({
      segments: [{ id: "subtitle-1", text: "useState hook" }],
      chapters: [{ title: "状态设计", startMs: 0, endMs: 1_000 }],
    });
  });
});
