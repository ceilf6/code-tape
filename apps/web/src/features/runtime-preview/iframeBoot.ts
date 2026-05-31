/**
 * Stringified iframe bootstrap script.
 *
 * Loaded as `<script type="module">` inside the sandboxed iframe. Responsibilities:
 *   - intercept console.{log,warn,error} and forward to the parent
 *   - block alert/confirm/prompt (return null) and report via blocked-alert
 *   - listen for `init` messages carrying user JS to evaluate
 *   - capture sync + async errors and post `error` events
 *   - on completion (Promise resolution or sync return), serialize document.body
 *     to a previewHtml string so the player can re-render it later
 *
 * This script never trusts message.source/origin — the parent validates that on
 * its side via IframeRuntime.acceptRuntimeMessage(). The script DOES verify that
 * messages it receives carry `type === "init"` and the correct `runId`, so a
 * second postMessage with a stale runId doesn't double-run.
 */
export const IFRAME_BOOT_SCRIPT = `
(function () {
  const RUNTIME_SOURCE = "code-tape-runtime";
  const CONSOLE_ARG_LIMIT = 50;
  const CONSOLE_ARG_MAX_CHARS = 2000;
  const PREVIEW_HTML_MAX_CHARS = 200000;
  let currentRunId = null;

  function limit(value, maxLength) {
    const text = String(value ?? "");
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function post(type, payload) {
    parent.postMessage({ source: RUNTIME_SOURCE, runId: currentRunId, type, payload }, "*");
  }

  function strArg(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
      return JSON.stringify(value);
    } catch (_e) {
      return String(value);
    }
  }

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = function () {
    originalConsole.log.apply(console, arguments);
    post("console", { level: "log", args: Array.prototype.map.call(arguments, strArg).slice(0, CONSOLE_ARG_LIMIT).map(function (arg) { return limit(arg, CONSOLE_ARG_MAX_CHARS); }) });
  };
  console.warn = function () {
    originalConsole.warn.apply(console, arguments);
    post("console", { level: "warn", args: Array.prototype.map.call(arguments, strArg).slice(0, CONSOLE_ARG_LIMIT).map(function (arg) { return limit(arg, CONSOLE_ARG_MAX_CHARS); }) });
  };
  console.error = function () {
    originalConsole.error.apply(console, arguments);
    post("console", { level: "error", args: Array.prototype.map.call(arguments, strArg).slice(0, CONSOLE_ARG_LIMIT).map(function (arg) { return limit(arg, CONSOLE_ARG_MAX_CHARS); }) });
  };

  window.alert = function (message) {
    post("blocked-alert", { message: limit(message, CONSOLE_ARG_MAX_CHARS) });
    return undefined;
  };
  window.confirm = function () { post("blocked-alert", { message: "confirm()" }); return false; };
  window.prompt = function () { post("blocked-alert", { message: "prompt()" }); return null; };

  window.addEventListener("error", function (event) {
    post("error", { message: limit(event.message || String(event.error || ""), CONSOLE_ARG_MAX_CHARS), stack: event.error && event.error.stack ? limit(event.error.stack, CONSOLE_ARG_MAX_CHARS) : undefined });
  });
  window.addEventListener("unhandledrejection", function (event) {
    const reason = event.reason || {};
    post("error", { message: limit(reason.message || String(reason), CONSOLE_ARG_MAX_CHARS), stack: reason.stack ? limit(reason.stack, CONSOLE_ARG_MAX_CHARS) : undefined });
  });

  // Allowed theme bodies (must match host themeStyleTag in iframeRuntime.ts).
  // Split by element so a user-provided body background propagates to the
  // canvas (per CSS canvas painting rule); values are hard-coded so a hostile
  // parent can't inject arbitrary CSS via setTheme.
  var THEME_HTML = { light: "color-scheme:light;", dark: "color-scheme:dark;" };
  var THEME_BODY = {
    light: "background:#f5f5f4;color:#24272d;",
    dark: "background:#1c1f26;color:#e7e9ee;",
  };

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.type !== "set-theme") return;
    var htmlBody = THEME_HTML[msg.theme];
    var bodyBody = THEME_BODY[msg.theme];
    if (!htmlBody || !bodyBody) return;
    var styleEl = document.getElementById("ct-theme");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "ct-theme";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      ":where(html){" + htmlBody + "}:where(body){" + bodyBody + "}";
  });

  window.addEventListener("message", async function (event) {
    const msg = event.data;
    if (!msg || msg.type !== "init") return;
    if (currentRunId && msg.runId === currentRunId) return; // ignore replays
    currentRunId = msg.runId;
    post("ready", {});
    const userScript = document.createElement("script");
    userScript.textContent = [
      "(async function () {",
      "  try {",
      "    const result = (async function __codeTapeUserMain() {",
      String(msg.code || ""),
      "    })();",
      "    if (result && typeof result.then === 'function') await result;",
      "    const previewHtml = document.body ? document.body.outerHTML : '';",
      "    parent.postMessage({ source: 'code-tape-runtime', runId: " + JSON.stringify(currentRunId) + ", type: 'complete', payload: { previewHtml: previewHtml.length > 200000 ? previewHtml.slice(0, 200000) : previewHtml } }, '*');",
      "  } catch (err) {",
      "    const message = String((err && err.message) || err || '');",
      "    const stack = err && err.stack ? String(err.stack) : undefined;",
      "    parent.postMessage({ source: 'code-tape-runtime', runId: " + JSON.stringify(currentRunId) + ", type: 'error', payload: { message: message.length > 2000 ? message.slice(0, 2000) : message, stack: stack && stack.length > 2000 ? stack.slice(0, 2000) : stack } }, '*');",
      "  }",
      "})();",
    ].join("\\n");
    document.body.appendChild(userScript);
  });
})();
`;
