import { describe, expect, it, vi } from "vitest";
import type {
  CompileLanguage,
  CompileResult,
  IframeRunInput,
  IframeRunResult,
  IframeRuntime,
  PreviewCompiler,
} from "@/shared/recording-schema";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import { createRuntimeProducer } from "../runtimeProducer";

function setup(overrides: {
  compile?: PreviewCompiler["compile"];
  run?: IframeRuntime["run"];
  renderDocument?: IframeRuntime["renderDocument"];
} = {}) {
  const clock = createRecordingClock({ nowProvider: () => 1000 });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  const compile = vi.fn(
    overrides.compile ??
      (async (source: string, _language: CompileLanguage): Promise<CompileResult> => ({
        ok: true,
        code: `compiled:${source}`,
        warnings: [],
      })),
  );
  const run = vi.fn(
    overrides.run ??
      (async (input: IframeRunInput): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "complete",
        previewHtml: "<body>ok</body>",
        stdout: ["hello"],
        stderr: [],
      })),
  );
  const renderDocument = vi.fn(
    overrides.renderDocument ?? (async (html: string): Promise<string> => html),
  );
  const compiler: PreviewCompiler = { compile };
  const runtime: IframeRuntime = {
    mount: vi.fn(),
    run,
    renderPreview: vi.fn(),
    renderDocument,
    setTheme: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  const producer = createRuntimeProducer({ bus, clock, compiler, runtime });
  clock.start();
  producer.start();
  return { bus, compile, producer, run, renderDocument, runtime };
}

describe("createRuntimeProducer", () => {
  it("emits run-start then run-output for a successful iframe run", async () => {
    const { bus, compile, producer, run } = setup();

    const result = await producer.trigger({
      language: "javascript",
      source: "console.log('hello')",
    });

    const runInput = run.mock.calls[0]?.[0];
    expect(runInput?.runId).toMatch(/^run-/);
    expect(runInput?.compiledCode).toBe("compiled:console.log('hello')");
    expect(runInput?.timeoutMs).toBe(3000);
    expect(compile).toHaveBeenCalledWith("console.log('hello')", "javascript");
    expect(result).toEqual({
      runId: runInput?.runId,
      status: "complete",
      previewHtml: "<body>ok</body>",
      stdout: ["hello"],
      stderr: [],
    });
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: runInput?.runId },
      },
      {
        type: "run-output",
        payload: {
          runId: runInput?.runId,
          stdout: ["hello"],
          stderr: [],
          previewHtml: "<body>ok</body>",
          status: "success",
        },
      },
    ]);
  });

  it("emits run-start then run-output for an HTML render (no JS compile/exec)", async () => {
    const { bus, compile, producer, run, renderDocument } = setup();

    const result = await producer.trigger({
      language: "html",
      source: "<h1>hi</h1>",
    });

    expect(compile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(renderDocument).toHaveBeenCalledWith("<h1>hi</h1>");
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.previewHtml).toBe("<h1>hi</h1>");
      expect(result.stdout).toEqual([]);
    }
    const events = bus.drain().map((event) => ({ type: event.type, payload: event.payload }));
    expect(events[0]).toEqual({
      type: "run-start",
      payload: { language: "html", runtime: "iframe", runId: result.runId },
    });
    expect(events[1]?.type).toBe("run-output");
  });

  it("wraps CSS in an HTML scaffold and renders it (no JS compile/exec)", async () => {
    const { compile, producer, run, renderDocument } = setup();

    const result = await producer.trigger({
      language: "css",
      source: "h1 { color: red; }",
    });

    expect(compile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const renderedHtml = renderDocument.mock.calls[0]?.[0] as string;
    expect(renderedHtml).toContain("<style>h1 { color: red; }</style>");
    expect(result.status).toBe("complete");
  });

  it("emits run-error if HTML render throws", async () => {
    const { bus, producer } = setup({
      renderDocument: async () => {
        throw new Error("render boom");
      },
    });

    const result = await producer.trigger({ language: "html", source: "<h1>x</h1>" });

    expect(result.status).toBe("error");
    const types = bus.drain().map((event) => event.type);
    expect(types).toEqual(["run-start", "run-error"]);
  });

  it("emits run-error with transpile phase when compilation fails", async () => {
    const { bus, producer, run } = setup({
      compile: async (): Promise<CompileResult> => ({
        ok: false,
        phase: "transpile",
        message: "Unexpected token",
        stack: "stacktrace",
      }),
    });

    const result = await producer.trigger({
      language: "typescript",
      source: "const x: = 1",
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.phase).toBe("transpile");
      expect(result.message).toBe("Unexpected token");
    }
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "typescript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "transpile",
          message: "Unexpected token",
          stack: "stacktrace",
          stdout: [],
          stderr: [],
          previewHtml: null,
        },
      },
    ]);
  });

  it("emits run-error with runtime phase when iframe run fails", async () => {
    const { bus, producer } = setup({
      run: async (input): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "error",
        phase: "runtime",
        message: "boom",
        stack: "stacktrace",
        stdout: ["before"],
        stderr: ["warn"],
      }),
    });

    const result = await producer.trigger({ language: "javascript", source: "throw new Error()" });

    expect(result.status).toBe("error");
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "runtime",
          message: "boom",
          stack: "stacktrace",
          stdout: ["before"],
          stderr: ["warn"],
          previewHtml: null,
        },
      },
    ]);
  });

  it("emits run-error with runtime phase when iframe run times out", async () => {
    const { bus, producer } = setup({
      run: async (input): Promise<IframeRunResult> => ({
        runId: input.runId,
        status: "timeout",
        stdout: ["partial"],
        stderr: [],
      }),
    });

    const result = await producer.trigger({ language: "javascript", source: "await never()" });

    expect(result.status).toBe("timeout");
    expect(bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run-start",
        payload: { language: "javascript", runtime: "iframe", runId: result.runId },
      },
      {
        type: "run-error",
        payload: {
          runId: result.runId,
          phase: "runtime",
          message: "runtime-timeout",
          stdout: ["partial"],
          stderr: [],
          previewHtml: null,
        },
      },
    ]);
  });

  it.each(["pause", "stop", "dispose"] as const)(
    "rejects trigger after %s without emitting runtime events",
    async (method) => {
      const { bus, compile, producer, run } = setup();
      producer[method]();

      await expect(producer.trigger({ language: "javascript", source: "1" })).rejects.toThrow(
        "RuntimeProducer is not active",
      );

      expect(compile).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(bus.drain()).toEqual([]);
    },
  );

  it("keeps stop terminal even if start is called again", async () => {
    const { bus, compile, producer, run } = setup();
    producer.stop();
    producer.start();

    await expect(producer.trigger({ language: "javascript", source: "1" })).rejects.toThrow(
      "RuntimeProducer is not active",
    );

    expect(compile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(bus.drain()).toEqual([]);
  });

  it("allows trigger after pause and resume", async () => {
    const { bus, producer } = setup();
    producer.pause();
    producer.resume();

    const result = await producer.trigger({ language: "javascript", source: "1" });

    expect(result.status).toBe("complete");
    expect(bus.drain().map((event) => event.type)).toEqual(["run-start", "run-output"]);
  });

  it("rejects overlapping trigger calls without emitting a second run", async () => {
    let runCount = 0;
    let resolveFirstRun: () => void = () => {
      throw new Error("first run was not started");
    };
    const { bus, compile, producer, run } = setup({
      run: (input) => {
        runCount += 1;
        if (runCount > 1) {
          return Promise.resolve({
            runId: input.runId,
            status: "complete",
            previewHtml: "<body>second</body>",
            stdout: [],
            stderr: [],
          });
        }
        return new Promise<IframeRunResult>((resolve) => {
          resolveFirstRun = () =>
            resolve({
              runId: input.runId,
              status: "complete",
              previewHtml: "<body>done</body>",
              stdout: [],
              stderr: [],
            });
        });
      },
    });

    const first = producer.trigger({ language: "javascript", source: "first" });
    await expect(producer.trigger({ language: "javascript", source: "second" })).rejects.toThrow(
      "RuntimeProducer is already running",
    );

    expect(compile).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    resolveFirstRun?.();
    await first;

    expect(bus.drain().map((event) => event.type)).toEqual(["run-start", "run-output"]);
  });
});
