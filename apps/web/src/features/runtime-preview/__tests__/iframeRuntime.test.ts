import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_CONSOLE_ARG_LIMIT,
  RUNTIME_CONSOLE_ARG_MAX_CHARS,
  RUNTIME_OUTPUT_LINE_LIMIT,
  RUNTIME_OUTPUT_TRUNCATED_NOTICE,
  RUNTIME_PREVIEW_HTML_MAX_CHARS,
  acceptRuntimeMessage,
  createIframeRuntime,
} from "../iframeRuntime";
import { IFRAME_BOOT_SCRIPT } from "../iframeBoot";

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options: {
      runScripts: "dangerously";
      url: string;
      virtualConsole: { on(event: "jsdomError", listener: () => void): unknown };
      beforeParse(window: Window): void;
    },
  ) => { window: Window & typeof globalThis & { close(): void } };
  VirtualConsole: new () => { on(event: "jsdomError", listener: () => void): unknown };
};

describe("acceptRuntimeMessage — schema + source validation", () => {
  const expected = { runId: "run-1", source: null };

  it("accepts a well-formed console message matching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: ["hello"] },
      },
      expected,
    );
    expect(result).not.toBeNull();
    expect(result?.type).toBe("console");
  });

  it("rejects messages with wrong source", () => {
    const result = acceptRuntimeMessage(
      {
        source: "evil-runtime",
        runId: "run-1",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with mismatching runId", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-OLD",
        type: "console",
        payload: { level: "log", args: [] },
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with unknown type", () => {
    const result = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "drop-table",
        payload: {},
      },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects messages with malformed payload", () => {
    const result = acceptRuntimeMessage(
      { source: "code-tape-runtime", runId: "run-1", type: "console", payload: "string" },
      expected,
    );
    expect(result).toBeNull();
  });

  it("rejects payloads that do not match their runtime message type", () => {
    expect(
      acceptRuntimeMessage(
        {
          source: "code-tape-runtime",
          runId: "run-1",
          type: "console",
          payload: { level: "debug", args: ["hello"] },
        },
        expected,
      ),
    ).toBeNull();
    expect(
      acceptRuntimeMessage(
        {
          source: "code-tape-runtime",
          runId: "run-1",
          type: "complete",
          payload: { previewHtml: 42 },
        },
        expected,
      ),
    ).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(acceptRuntimeMessage(null, expected)).toBeNull();
    expect(acceptRuntimeMessage("hi", expected)).toBeNull();
    expect(acceptRuntimeMessage(42, expected)).toBeNull();
  });

  it("caps console args and previewHtml to P0 runtime budgets", () => {
    const consoleResult = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "console",
        payload: {
          level: "log",
          args: Array.from({ length: RUNTIME_CONSOLE_ARG_LIMIT + 10 }, () =>
            "x".repeat(RUNTIME_CONSOLE_ARG_MAX_CHARS + 10),
          ),
        },
      },
      expected,
    );
    const previewResult = acceptRuntimeMessage(
      {
        source: "code-tape-runtime",
        runId: "run-1",
        type: "complete",
        payload: { previewHtml: "x".repeat(RUNTIME_PREVIEW_HTML_MAX_CHARS + 10) },
      },
      expected,
    );

    expect(consoleResult?.type).toBe("console");
    if (consoleResult?.type === "console") {
      expect(consoleResult.payload.args).toHaveLength(RUNTIME_CONSOLE_ARG_LIMIT);
      expect(consoleResult.payload.args[0]).toHaveLength(RUNTIME_CONSOLE_ARG_MAX_CHARS);
    }
    expect(previewResult?.type).toBe("complete");
    if (previewResult?.type === "complete") {
      expect(previewResult.payload.previewHtml).toHaveLength(RUNTIME_PREVIEW_HTML_MAX_CHARS);
    }
  });
});

describe("IframeRuntime sandbox lifecycle", () => {
  it("does not require unsafe-eval to execute user code", () => {
    expect(IFRAME_BOOT_SCRIPT).not.toContain("new Function");
  });

  it("creates a fresh run iframe for every run", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const mountedFrame = host.querySelector("iframe");
    const firstRun = runtime.run({ runId: "run-1", compiledCode: "", timeoutMs: 1 });
    const firstRunFrame = host.querySelector("iframe");
    await firstRun;
    const secondRun = runtime.run({ runId: "run-2", compiledCode: "", timeoutMs: 1 });
    const secondRunFrame = host.querySelector("iframe");
    await secondRun;

    expect(firstRunFrame).not.toBe(mountedFrame);
    expect(secondRunFrame).not.toBe(firstRunFrame);
    runtime.destroy();
    host.remove();
  });

  it("injects the technical-plan CSP into executable runtime srcdoc", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const run = runtime.run({ runId: "run-1", compiledCode: "", timeoutMs: 1 });
    const frame = host.querySelector("iframe");
    await run;

    expect(frame?.srcdoc).toContain("Content-Security-Policy");
    expect(frame?.srcdoc).toContain("default-src 'none'");
    expect(frame?.srcdoc).toContain("connect-src 'none'");
    runtime.destroy();
    host.remove();
  });

  it("destroys the run iframe on timeout so runaway async tasks stop", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const run = runtime.run({ runId: "run-timeout", compiledCode: "", timeoutMs: 1 });
    expect(host.querySelector("iframe")).not.toBeNull();
    const result = await run;

    expect(result.status).toBe("timeout");
    expect(host.querySelector("iframe")).toBeNull();
    runtime.destroy();
    host.remove();
  });

  it("injects a dark theme background into the empty preview srcdoc by default", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const frame = host.querySelector("iframe");

    expect(frame?.srcdoc).toContain("color-scheme:dark");
    expect(frame?.srcdoc).toContain("#1c1f26"); // dark default background
    runtime.destroy();
    host.remove();
  });

  it("injects a light theme background when initialized with theme: 'light'", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime({ theme: "light" });

    await runtime.mount(host);
    const frame = host.querySelector("iframe");

    expect(frame?.srcdoc).toContain("color-scheme:light");
    expect(frame?.srcdoc).toContain("#f5f5f4"); // light default background
    runtime.destroy();
    host.remove();
  });

  it("re-renders the current preview with the new theme on setTheme", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime({ theme: "dark" });

    await runtime.mount(host);
    expect(host.querySelector("iframe")?.srcdoc).toContain("color-scheme:dark");

    runtime.setTheme("light");
    // setTheme triggers an async re-render; wait a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector("iframe")?.srcdoc).toContain("color-scheme:light");

    runtime.destroy();
    host.remove();
  });

  it("preserves the rendered preview content across a theme change", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime({ theme: "dark" });

    await runtime.mount(host);
    await runtime.renderPreview("<body><h1>kept</h1></body>");
    expect(host.querySelector("iframe")?.srcdoc).toContain("<h1>kept</h1>");

    runtime.setTheme("light");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const srcdoc = host.querySelector("iframe")?.srcdoc ?? "";
    expect(srcdoc).toContain("<h1>kept</h1>");
    expect(srcdoc).toContain("color-scheme:light");
    runtime.destroy();
    host.remove();
  });

  it("uses :where() for the theme default so user CSS wins regardless of source order", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const srcdoc = host.querySelector("iframe")?.srcdoc ?? "";
    // Default selectors must have zero specificity (`:where()` per CSS spec)
    // so any user `body { ... }` rule wins regardless of source order.
    expect(srcdoc).toContain(":where(html)");
    expect(srcdoc).toContain(":where(body)");
    expect(srcdoc).not.toMatch(/<style[^>]*>html\{|<style[^>]*>body\{/);
    runtime.destroy();
    host.remove();
  });

  it("scopes background/color to body so user body bg propagates to the canvas", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const srcdoc = host.querySelector("iframe")?.srcdoc ?? "";
    // CSS canvas painting only propagates body bg when html has no bg of its own.
    // Theme defaults: color-scheme on html; background/color only on body.
    expect(srcdoc).toMatch(/:where\(html\)\{color-scheme:(light|dark);\}/);
    expect(srcdoc).not.toMatch(/:where\(html\)\{[^}]*background/);
    expect(srcdoc).toMatch(/:where\(body\)\{background:[^;]+;color:[^;]+;\}/);
    runtime.destroy();
    host.remove();
  });

  it("does not reset body margin in the theme default style", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const srcdoc = host.querySelector("iframe")?.srcdoc ?? "";
    // Theme tag is identifiable, but it must not modify layout (no margin reset).
    expect(srcdoc).toContain('id="ct-theme"');
    expect(srcdoc).not.toMatch(/margin\s*:\s*0/);
    runtime.destroy();
    host.remove();
  });

  it("sends run init and theme updates over the runtime control port", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime({ theme: "dark" });

    await runtime.mount(host);
    // Start a long-running JS run so the iframe stays mounted.
    const run = runtime.run({
      runId: "run-theme",
      compiledCode: "console.log('secret code');",
      timeoutMs: 200,
    });
    const frame = host.querySelector("iframe");
    expect(frame).toBeTruthy();
    const postSpy = vi.spyOn(frame!.contentWindow!, "postMessage");
    const channel = new MessageChannel();
    const controlMessages: unknown[] = [];
    channel.port1.addEventListener("message", (event) => controlMessages.push(event.data));
    channel.port1.start();

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame!.contentWindow,
        data: { source: "code-tape-runtime", type: "control-port" },
        ports: [channel.port2],
      }),
    );
    await waitForCondition(() =>
      expect(controlMessages).toContainEqual({
        type: "init",
        runId: "run-theme",
        code: "console.log('secret code');",
      }),
    );

    runtime.setTheme("light");
    // setTheme should NOT replace the run iframe; it should postMessage instead.
    expect(host.querySelector("iframe")).toBe(frame);
    await waitForCondition(() =>
      expect(controlMessages).toContainEqual({ type: "set-theme", theme: "light" }),
    );
    expect(postSpy).not.toHaveBeenCalled();

    await run;
    runtime.destroy();
    host.remove();
  });

  it("renders replay preview in a no-script sandbox", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview("<body><script>window.__executed = true</script><p>safe</p></body>");
    const frame = host.querySelector("iframe");

    expect(frame?.getAttribute("sandbox")).toBe("");
    runtime.destroy();
    host.remove();
  });

  it("strips scripts from replay preview HTML before writing the no-script sandbox", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview(
      "<body><script>window.__executed = true</script><p>safe</p><script type=\"module\">console.log('again')</script></body>",
    );
    const frame = host.querySelector("iframe");

    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.srcdoc).toContain("<p>safe</p>");
    expect(frame?.srcdoc).not.toMatch(/<script/i);
    runtime.destroy();
    host.remove();
  });

  it("preserves non-script head content when sanitizing replay preview HTML", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview(
      '<!doctype html><html><head><style>.safe { color: red; }</style><script>window.__head = true</script></head><body><p class="safe">safe</p><script>window.__body = true</script></body></html>',
    );
    const frame = host.querySelector("iframe");

    expect(frame?.srcdoc).toContain("<style>.safe { color: red; }</style>");
    expect(frame?.srcdoc).toContain('<p class="safe">safe</p>');
    expect(frame?.srcdoc).not.toMatch(/<script/i);
    expect(frame?.srcdoc).toContain("script-src 'none'");
    runtime.destroy();
    host.remove();
  });

  it("renders a document in a no-script sandbox and returns sanitized markup", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const returned = await runtime.renderDocument(
      "<body><h1>hello</h1><script>window.x=1</script></body>",
    );
    const frame = host.querySelector("iframe");

    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.srcdoc).toContain("script-src 'none'");
    expect(frame?.srcdoc).toContain("<h1>hello</h1>");
    expect(frame?.srcdoc).not.toMatch(/<script/i);
    // 返回值是净化后的标记（脚本已剥离），作为 previewHtml 持久化时不含脚本。
    expect(returned).toContain("<h1>hello</h1>");
    expect(returned).not.toMatch(/<script/i);
    expect(returned).not.toContain("window.x=1");
    runtime.destroy();
    host.remove();
  });

  it("keeps the mounted host usable after reset", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview("<body><p>first</p></body>");
    runtime.reset();
    expect(host.querySelector("iframe")).toBeNull();

    await runtime.renderPreview("<body><p>second</p></body>");
    expect(host.querySelector("iframe")?.srcdoc).toContain("second");

    runtime.reset();
    const runAfterReset = runtime.run({ runId: "run-after-reset", compiledCode: "", timeoutMs: 1 });
    expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    await runAfterReset;

    runtime.destroy();
    host.remove();
  });

  it("caps combined stdout/stderr to the per-run line limit and flags truncation", async () => {
    const cases: Array<{ name: string; level: "log" | "error" }> = [
      { name: "stdout flood", level: "log" },
      { name: "stderr flood", level: "error" },
    ];
    for (const { level } of cases) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const runtime = createIframeRuntime();

      await runtime.mount(host);
      const run = runtime.run({ runId: "run-flood", compiledCode: "", timeoutMs: 200 });
      const frame = host.querySelector("iframe");
      const source = frame?.contentWindow;
      expect(source).toBeTruthy();
      // The message handler is registered after the iframe load event fires inside
      // run(); wait a macrotask so dispatched console messages are observed.
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let i = 0; i < RUNTIME_OUTPUT_LINE_LIMIT + 50; i += 1) {
        window.dispatchEvent(
          new MessageEvent("message", {
            source,
            data: {
              source: "code-tape-runtime",
              runId: "run-flood",
              type: "console",
              payload: { level, args: [`line-${i}`] },
            },
          }),
        );
      }
      const result = await run;

      expect(result.status).toBe("timeout");
      const combined = result.stdout.length + result.stderr.length;
      expect(combined).toBe(RUNTIME_OUTPUT_LINE_LIMIT);
      expect(result.stderr).toContain(RUNTIME_OUTPUT_TRUNCATED_NOTICE);
      runtime.destroy();
      host.remove();
    }
  });

  it("keeps the combined cap when stdout and stderr flood together", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const run = runtime.run({ runId: "run-mixed", compiledCode: "", timeoutMs: 200 });
    const frame = host.querySelector("iframe");
    const source = frame?.contentWindow;
    expect(source).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < RUNTIME_OUTPUT_LINE_LIMIT + 50; i += 1) {
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: {
            source: "code-tape-runtime",
            runId: "run-mixed",
            type: "console",
            payload: { level: i % 2 === 0 ? "log" : "error", args: [`line-${i}`] },
          },
        }),
      );
    }
    const result = await run;

    expect(result.status).toBe("timeout");
    expect(result.stdout.length + result.stderr.length).toBe(RUNTIME_OUTPUT_LINE_LIMIT);
    expect(result.stderr).toContain(RUNTIME_OUTPUT_TRUNCATED_NOTICE);
    // The truncation notice occupies the reserved final slot — never overflows.
    expect(result.stderr.filter((line) => line === RUNTIME_OUTPUT_TRUNCATED_NOTICE)).toHaveLength(1);
    runtime.destroy();
    host.remove();
  });
});

describe("IFRAME_BOOT_SCRIPT error reporting", () => {
  it("executes user code in global script scope so inline HTML handlers can call declared functions", async () => {
    const messages = await runBootScript(`
      document.body.innerHTML = '<h1 id="title">hello</h1><button onclick="changeText()">切换文字</button>';
      function changeText() {
        const title = document.getElementById('title');
        title.innerHTML = title.innerHTML === 'hello' ? '你好' : 'hello';
      }
      document.querySelector('button').click();
    `);
    const errors = messages.filter((message) => message.type === "error");
    const complete = messages.find((message) => message.type === "complete");

    expect(errors).toHaveLength(0);
    expect(complete?.payload).toEqual(
      expect.objectContaining({
        previewHtml: expect.stringContaining("<h1 id=\"title\">你好</h1>"),
      }),
    );
  });

  it("reports syntax errors as runtime errors without completing", async () => {
    const messages = await runBootScript("const broken = ;");
    const error = expectSingleRuntimeError(messages);

    expect(error.payload.message).not.toHaveLength(0);
  });

  it("reports synchronous throws as runtime errors without completing", async () => {
    const messages = await runBootScript('throw new Error("sync boom");');
    const error = expectSingleRuntimeError(messages);

    expect(error.payload.message).toContain("sync boom");
  });

  it("reports async throws as runtime errors without completing", async () => {
    const messages = await runBootScript('setTimeout(() => { throw new Error("async boom"); }, 0);');
    const error = expectSingleRuntimeError(messages);

    expect(error.payload.message).toContain("async boom");
  });
});

type PostedRuntimeMessage = {
  source?: unknown;
  runId?: unknown;
  type?: unknown;
  payload?: unknown;
};

async function runBootScript(code: string): Promise<PostedRuntimeMessage[]> {
  const messages: PostedRuntimeMessage[] = [];
  let controlPort: MessagePort | null = null;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => undefined);
  const dom = new JSDOM(
    `<!doctype html><html><body><script>${IFRAME_BOOT_SCRIPT}</script></body></html>`,
    {
      runScripts: "dangerously",
      url: "https://runtime.code-tape.test/",
      virtualConsole,
      beforeParse(window) {
        Object.defineProperty(window, "MessageChannel", {
          configurable: true,
          value: globalThis.MessageChannel,
        });
        Object.defineProperty(window, "parent", {
          configurable: true,
          value: {
            postMessage(message: PostedRuntimeMessage, _targetOrigin?: string, transfer?: Transferable[]) {
              messages.push(message);
              const [maybePort] = transfer ?? [];
              if (message.type === "control-port" && maybePort && "postMessage" in maybePort) {
                controlPort = maybePort as MessagePort;
              }
            },
          },
        });
      },
    },
  );

  try {
    const runtimeControlPort = controlPort as MessagePort | null;
    runtimeControlPort?.postMessage({ type: "init", runId: "run-error-path", code });
    await waitForBootScript(messages);
    return messages;
  } finally {
    dom.window.close();
  }
}

async function waitForBootScript(messages: PostedRuntimeMessage[]): Promise<void> {
  await waitForCondition(() => {
    expect(messages.some((message) => message.type === "complete" || message.type === "error")).toBe(
      true,
    );
  });
}

async function waitForCondition(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (lastError) throw lastError;
  assertion();
}

function expectSingleRuntimeError(messages: PostedRuntimeMessage[]): {
  payload: { message: string };
} {
  const errors = messages.filter((message) => message.type === "error");

  expect(messages.some((message) => message.type === "ready")).toBe(true);
  expect(messages.some((message) => message.type === "complete")).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toEqual(
    expect.objectContaining({
      source: "code-tape-runtime",
      runId: "run-error-path",
      type: "error",
      payload: expect.objectContaining({ message: expect.any(String) }),
    }),
  );
  return errors[0] as { payload: { message: string } };
}
