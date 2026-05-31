import type {
  CreateRuntimeProducer,
  RuntimeProducerHandle,
  RuntimeProducerRunResult,
} from "./types";
import type { CompileResult, IframeRunResult, RunErrorPayload } from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";

const RUNTIME_TIMEOUT_MS = 3000;

/**
 * RuntimeProducer — emits run-start / run-output / run-error.
 */
function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

/**
 * 为 HTML/CSS「运行」构造注入 no-script sandbox 的静态文档。
 * - HTML：源码本身即文档（renderDocument 内部会剥离 <script> 并套 CSP）。
 * - CSS：包进最小 HTML 脚手架的 <style>，让用户看到样式作用在示例结构上。
 */
function buildRenderDocument(language: "html" | "css", source: string): string {
  if (language === "html") return source;
  return [
    "<body>",
    `<style>${source}</style>`,
    '<main class="code-tape-css-preview">',
    "<h1>CSS Preview</h1>",
    "<p>这是用于预览样式效果的示例文本。This is sample text for previewing your styles.</p>",
    '<button type="button">Button</button>',
    "</main>",
    "</body>",
  ].join("");
}

export const createRuntimeProducer: CreateRuntimeProducer = (deps): RuntimeProducerHandle => {
  const { bus, compiler, runtime } = deps;
  let paused = false;
  let stopped = false;
  let disposed = false;
  let running = false;

  const assertActive = () => {
    if (paused || stopped || disposed) throw new Error("RuntimeProducer is not active");
    if (running) throw new Error("RuntimeProducer is already running");
  };

  const emitRunError = (payload: RunErrorPayload) => {
    bus.emit({
      type: "run-error",
      source: "runtime",
      track: "runtime",
      payload,
    });
  };

  const emitCompileError = (
    runId: string,
    error: Extract<CompileResult, { ok: false }>,
  ): RuntimeProducerRunResult => {
    const result: RuntimeProducerRunResult = {
      runId,
      status: "error",
      phase: "transpile",
      message: error.message,
      stack: error.stack,
      stdout: [],
      stderr: [],
      previewHtml: null,
    };
    emitRunError({
      runId,
      phase: result.phase,
      message: result.message,
      stack: result.stack,
      stdout: result.stdout,
      stderr: result.stderr,
      previewHtml: result.previewHtml,
    });
    return result;
  };

  const emitRuntimeThrownError = (runId: string, err: unknown): IframeRunResult => {
    const info = errorInfo(err);
    const result: IframeRunResult = {
      runId,
      status: "error",
      phase: "runtime",
      message: info.message,
      stack: info.stack,
      stdout: [],
      stderr: [],
    };
    emitRunError({ ...result, previewHtml: null });
    return result;
  };

  return {
    start() {
      if (stopped || disposed) return;
      paused = false;
    },
    pause() {
      if (stopped || disposed) return;
      paused = true;
    },
    resume() {
      if (stopped || disposed) return;
      paused = false;
    },
    stop() {
      stopped = true;
      paused = false;
    },
    dispose() {
      disposed = true;
      stopped = true;
      paused = false;
    },
    async trigger(input): Promise<RuntimeProducerRunResult> {
      assertActive();
      running = true;
      try {
        const runId = generateId("run");
        bus.emit({
          type: "run-start",
          source: "runtime",
          track: "runtime",
          payload: {
            language: input.language,
            runtime: "iframe",
            runId,
          },
        });

        // HTML/CSS：渲染到只读（no-script）sandbox，不走 JS 编译/执行链路。
        if (input.language === "html" || input.language === "css") {
          let previewHtml: string;
          try {
            previewHtml = await runtime.renderDocument(buildRenderDocument(input.language, input.source));
          } catch (err) {
            return emitRuntimeThrownError(runId, err);
          }
          bus.emit({
            type: "run-output",
            source: "runtime",
            track: "runtime",
            payload: { runId, stdout: [], stderr: [], previewHtml, status: "success" },
          });
          return {
            runId,
            status: "complete",
            previewHtml,
            stdout: [],
            stderr: [],
          };
        }

        let compiled: CompileResult;
        try {
          compiled = await compiler.compile(input.source, input.language);
        } catch (err) {
          return emitCompileError(runId, { ok: false, phase: "transpile", ...errorInfo(err) });
        }
        if (!compiled.ok) return emitCompileError(runId, compiled);

        let result: IframeRunResult;
        try {
          result = await runtime.run({
            runId,
            compiledCode: compiled.code,
            timeoutMs: RUNTIME_TIMEOUT_MS,
          });
        } catch (err) {
          return emitRuntimeThrownError(runId, err);
        }

        if (result.status === "complete") {
          bus.emit({
            type: "run-output",
            source: "runtime",
            track: "runtime",
            payload: {
              runId,
              stdout: result.stdout,
              stderr: result.stderr,
              previewHtml: result.previewHtml,
              status: "success",
            },
          });
          return result;
        }

        if (result.status === "timeout") {
          emitRunError({
            runId,
            phase: "runtime",
            message: "runtime-timeout",
            stdout: result.stdout,
            stderr: result.stderr,
            previewHtml: null,
          });
          return result;
        }

        emitRunError({
          runId,
          phase: "runtime",
          message: result.message,
          stack: result.stack,
          stdout: result.stdout,
          stderr: result.stderr,
          previewHtml: null,
        });
        return result;
      } finally {
        running = false;
      }
    },
  };
};
