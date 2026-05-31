import type {
  IframeRunInput,
  IframeRunResult,
  IframeRuntime,
  RuntimeMessage,
} from "@/shared/recording-schema";
import { IFRAME_BOOT_SCRIPT } from "./iframeBoot";

export type IframeRuntimeOptions = {
  /** Override sandbox attributes; only "allow-scripts" is on by default. */
  sandboxFlags?: string;
};

const RUNTIME_SOURCE = "code-tape-runtime";
export const RUNTIME_CONSOLE_ARG_LIMIT = 50;
export const RUNTIME_CONSOLE_ARG_MAX_CHARS = 2_000;
export const RUNTIME_PREVIEW_HTML_MAX_CHARS = 200_000;
/** Per-run cap on the combined stdout + stderr line count (including the
 *  reserved truncation-notice slot) — bounds memory and recording size when
 *  async code floods console before the run timeout fires. */
export const RUNTIME_OUTPUT_LINE_LIMIT = 1_000;
export const RUNTIME_OUTPUT_TRUNCATED_NOTICE = "[输出已截断：超过单次运行行数上限]";

const RUNTIME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none';";
const REPLAY_PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none';";

type SanitizedPreviewHtml = {
  headHtml: string;
  bodyHtml: string;
};

/**
 * Validate that an incoming postMessage genuinely came from our iframe runtime
 * and matches the current run. Exported so unit tests can poke at the predicate
 * without spinning up a real iframe.
 */
export function acceptRuntimeMessage(
  raw: unknown,
  expected: { runId: string | null; source: MessageEventSource | null },
  event: { source: MessageEventSource | null } = { source: null },
): RuntimeMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { source?: unknown; runId?: unknown; type?: unknown; payload?: unknown };
  if (m.source !== RUNTIME_SOURCE) return null;
  if (typeof m.runId !== "string") return null;
  if (expected.runId && m.runId !== expected.runId) return null;
  if (expected.source && event.source !== expected.source) return null;
  const validTypes = ["ready", "console", "error", "blocked-alert", "complete"];
  if (typeof m.type !== "string" || !validTypes.includes(m.type)) return null;
  if (!m.payload || typeof m.payload !== "object") return null;
  if (!isRuntimePayload(m.type, m.payload)) return null;
  return sanitizeRuntimeMessage(m as RuntimeMessage);
}

function buildSrcDoc(bootScript: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${RUNTIME_CSP}" /><title>code-tape runtime</title></head><body><script>${bootScript}</script></body></html>`;
}

function buildPreviewSrcDoc(previewHtml: string): string {
  const safePreviewHtml = sanitizePreviewHtml(previewHtml);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPLAY_PREVIEW_CSP}" /><title>code-tape replay preview</title>${safePreviewHtml.headHtml}</head>${safePreviewHtml.bodyHtml}</html>`;
}

function isRuntimePayload(type: string, payload: object): boolean {
  const p = payload as Record<string, unknown>;
  switch (type) {
    case "ready":
      return true;
    case "console":
      return (
        (p.level === "log" || p.level === "warn" || p.level === "error") &&
        Array.isArray(p.args) &&
        p.args.every((arg) => typeof arg === "string")
      );
    case "error":
      return typeof p.message === "string" && (typeof p.stack === "undefined" || typeof p.stack === "string");
    case "blocked-alert":
      return typeof p.message === "string";
    case "complete":
      return typeof p.previewHtml === "string";
    default:
      return false;
  }
}

function limitString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizePreviewHtml(previewHtml: string): SanitizedPreviewHtml {
  const cappedPreviewHtml = limitString(previewHtml, RUNTIME_PREVIEW_HTML_MAX_CHARS);
  if (typeof DOMParser === "undefined") {
    return sanitizePreviewHtmlWithoutParser(cappedPreviewHtml);
  }
  const doc = new DOMParser().parseFromString(cappedPreviewHtml, "text/html");
  doc.querySelectorAll("script").forEach((script) => script.remove());
  return {
    headHtml: doc.head?.innerHTML ?? "",
    bodyHtml: doc.body?.outerHTML ?? "<body></body>",
  };
}

function sanitizePreviewHtmlWithoutParser(previewHtml: string): SanitizedPreviewHtml {
  const withoutScripts = previewHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const headMatch = withoutScripts.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = withoutScripts.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
  return {
    headHtml: headMatch?.[1] ?? "",
    bodyHtml: bodyMatch ? `<body${bodyMatch[1]}>${bodyMatch[2]}</body>` : `<body>${withoutScripts}</body>`,
  };
}

function sanitizeRuntimeMessage(message: RuntimeMessage): RuntimeMessage {
  switch (message.type) {
    case "console":
      return {
        ...message,
        payload: {
          ...message.payload,
          args: message.payload.args
            .slice(0, RUNTIME_CONSOLE_ARG_LIMIT)
            .map((arg) => limitString(arg, RUNTIME_CONSOLE_ARG_MAX_CHARS)),
        },
      };
    case "error":
      return {
        ...message,
        payload: {
          message: limitString(message.payload.message, RUNTIME_CONSOLE_ARG_MAX_CHARS),
          ...(message.payload.stack
            ? { stack: limitString(message.payload.stack, RUNTIME_CONSOLE_ARG_MAX_CHARS) }
            : {}),
        },
      };
    case "blocked-alert":
      return {
        ...message,
        payload: { message: limitString(message.payload.message, RUNTIME_CONSOLE_ARG_MAX_CHARS) },
      };
    case "complete":
      return {
        ...message,
        payload: {
          previewHtml: limitString(message.payload.previewHtml, RUNTIME_PREVIEW_HTML_MAX_CHARS),
        },
      };
    case "ready":
      return message;
  }
}

export function createIframeRuntime(options: IframeRuntimeOptions = {}): IframeRuntime {
  let iframe: HTMLIFrameElement | null = null;
  let host: HTMLElement | null = null;
  let messageHandler: ((event: MessageEvent) => void) | null = null;

  const sandboxFlags = options.sandboxFlags ?? "allow-scripts";

  const teardown = () => {
    if (messageHandler) window.removeEventListener("message", messageHandler);
    messageHandler = null;
    if (iframe && iframe.parentElement) iframe.parentElement.removeChild(iframe);
    iframe = null;
  };

  const createIframe = (sandbox: string, srcdoc: string): Promise<HTMLIFrameElement> => {
    if (!host) throw new Error("IframeRuntime: mount(host) must be called first");
    teardown();
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", sandbox);
    el.setAttribute("title", "code-tape preview");
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.border = "0";
    el.srcdoc = srcdoc;
    iframe = el;
    return new Promise((resolve) => {
      el.addEventListener("load", () => resolve(el), { once: true });
      host!.appendChild(el);
    });
  };

  return {
    async mount(target: HTMLElement) {
      host = target;
      if (!iframe) await createIframe("", buildPreviewSrcDoc("<body></body>"));
    },
    async run(input: IframeRunInput): Promise<IframeRunResult> {
      const frame = await createIframe(sandboxFlags, buildSrcDoc(IFRAME_BOOT_SCRIPT));
      const stdout: string[] = [];
      const stderr: string[] = [];
      let outputTruncated = false;
      // Shared cap over stdout + stderr (a runaway async task can flood either
      // stream). The final slot is reserved for the truncation notice so the
      // combined line count never exceeds RUNTIME_OUTPUT_LINE_LIMIT.
      const pushOutput = (sink: string[], line: string) => {
        if (outputTruncated) return;
        const total = stdout.length + stderr.length;
        if (total >= RUNTIME_OUTPUT_LINE_LIMIT - 1) {
          outputTruncated = true;
          stderr.push(RUNTIME_OUTPUT_TRUNCATED_NOTICE);
          return;
        }
        sink.push(line);
      };

      return new Promise<IframeRunResult>((resolve) => {
        let settled = false;
        const finish = (result: IframeRunResult) => {
          if (settled) return;
          settled = true;
          if (messageHandler) window.removeEventListener("message", messageHandler);
          messageHandler = null;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          // Destroy the run iframe so a runaway async task (setInterval, fetch
          // retry loop, unbounded DOM growth, etc.) stops consuming CPU/memory
          // once we give up — matches the 技术方案 timeout contract ("销毁 iframe").
          if (iframe === frame) teardown();
          finish({ runId: input.runId, status: "timeout", stdout, stderr });
        }, input.timeoutMs);

        messageHandler = (event: MessageEvent) => {
          const msg = acceptRuntimeMessage(
            event.data,
            { runId: input.runId, source: frame.contentWindow },
            { source: event.source },
          );
          if (!msg) return;
          switch (msg.type) {
            case "console":
              if (msg.payload.level === "error") pushOutput(stderr, msg.payload.args.join(" "));
              else pushOutput(stdout, msg.payload.args.join(" "));
              break;
            case "error":
              finish({
                runId: input.runId,
                status: "error",
                phase: "runtime",
                message: msg.payload.message,
                stack: msg.payload.stack,
                stdout,
                stderr,
              });
              break;
            case "blocked-alert":
              pushOutput(stderr, `[blocked] ${msg.payload.message}`);
              break;
            case "complete":
              finish({
                runId: input.runId,
                status: "complete",
                previewHtml: msg.payload.previewHtml,
                stdout,
                stderr,
              });
              break;
            case "ready":
              break;
          }
        };
        window.addEventListener("message", messageHandler);
        frame.contentWindow?.postMessage(
          { type: "init", runId: input.runId, code: input.compiledCode },
          "*",
        );
      });
    },
    async renderPreview(previewHtml: string): Promise<void> {
      await createIframe("", buildPreviewSrcDoc(previewHtml));
    },
    async renderDocument(html: string): Promise<string> {
      const safe = sanitizePreviewHtml(html);
      await createIframe("", buildPreviewSrcDoc(html));
      // Return the SANITIZED markup actually rendered (scripts stripped), so the
      // persisted previewHtml is script-free regardless of who re-renders it.
      const sanitized = safe.headHtml ? `${safe.headHtml}${safe.bodyHtml}` : safe.bodyHtml;
      return limitString(sanitized, RUNTIME_PREVIEW_HTML_MAX_CHARS);
    },
    reset() {
      teardown();
    },
    destroy() {
      teardown();
      host = null;
    },
  };
}
