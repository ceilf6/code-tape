import type { CreateShortcutProducer } from "./types";

const SHORTCUT_DEDUPE_MS = 500;
const TARGET_REFRESH_MS = 16;

type ResolvedShortcut = {
  signature: string;
  keys: string[];
  label: string;
  command?: string;
};

export const createShortcutProducer: CreateShortcutProducer = (deps) => {
  let active = false;
  let disposed = false;
  let listeningTarget: Window | null = null;
  let refreshTimer: number | null = null;
  const lastEmittedAtBySignature = new Map<string, number>();
  const keydownListener: EventListener = (event) => {
    if (isKeyboardEvent(event)) handleKeyDown(event);
  };

  const stopRefreshTimer = () => {
    if (refreshTimer === null) return;
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  };

  const startRefreshTimer = () => {
    if (refreshTimer !== null) return;
    refreshTimer = window.setInterval(attach, TARGET_REFRESH_MS);
  };

  const detach = () => {
    if (!listeningTarget) return;
    listeningTarget.removeEventListener("keydown", keydownListener, true);
    listeningTarget = null;
  };

  const attach = () => {
    if (!active || disposed) return;
    const nextTarget = listenerTargetForRoot(deps.getRoot());
    if (nextTarget === listeningTarget) return;
    detach();
    if (!nextTarget) return;
    nextTarget.addEventListener("keydown", keydownListener, true);
    listeningTarget = nextTarget;
  };

  const resolveShortcut = (event: KeyboardEvent): ResolvedShortcut | null => {
    if (!isControlShortcut(event)) return null;
    const keys = shortcutKeys(event);
    if (keys.length === 0) return null;
    const signature = keys.join("+");
    const custom = deps.resolveLabel?.(event);
    if (custom) {
      return { signature, keys, label: custom.label, command: custom.command };
    }
    const known = KNOWN_SHORTCUTS[signature];
    if (known) return { signature, keys, ...known };
    return { signature, keys, label: keys.join(" + ") };
  };

  function handleKeyDown(event: KeyboardEvent) {
    const eventSourceTarget = listeningTarget;
    attach();
    if (!active || disposed) return;
    if (!isInsideCurrentRoot(event, eventSourceTarget)) return;
    const shortcut = resolveShortcut(event);
    if (!shortcut) return;
    const now = event.timeStamp ?? Date.now();
    const lastEmittedAt = lastEmittedAtBySignature.get(shortcut.signature);
    if (lastEmittedAt !== undefined && now - lastEmittedAt < SHORTCUT_DEDUPE_MS) return;
    lastEmittedAtBySignature.set(shortcut.signature, now);
    const payload = {
      keys: shortcut.keys,
      label: shortcut.label,
      ...(shortcut.command ? { command: shortcut.command } : {}),
    };
    deps.bus.emit({
      type: "shortcut",
      source: "shortcut",
      track: "ui",
      payload,
    });
  }

  function isInsideCurrentRoot(event: KeyboardEvent, eventSourceTarget: Window | null): boolean {
    const currentRoot = deps.getRoot();
    if (!currentRoot) return false;
    if (isWindowRoot(currentRoot)) {
      return eventSourceTarget === currentRoot;
    }
    return isNodeTarget(event.target) && currentRoot.contains(event.target);
  }

  return {
    start() {
      if (disposed) return;
      active = true;
      attach();
      startRefreshTimer();
    },
    pause() {
      active = false;
      stopRefreshTimer();
      detach();
      lastEmittedAtBySignature.clear();
    },
    resume() {
      if (disposed) return;
      active = true;
      attach();
      startRefreshTimer();
    },
    stop() {
      active = false;
      stopRefreshTimer();
      detach();
      lastEmittedAtBySignature.clear();
    },
    dispose() {
      disposed = true;
      active = false;
      stopRefreshTimer();
      detach();
      lastEmittedAtBySignature.clear();
    },
  };
};

const KNOWN_SHORTCUTS: Record<string, { label: string; command: string }> = {
  "Cmd+S": { label: "Format", command: "format" },
  "Ctrl+S": { label: "Format", command: "format" },
  "Shift+Alt+F": { label: "Format", command: "format" },
  "Shift+Option+F": { label: "Format", command: "format" },
  "Cmd+/": { label: "Comment", command: "comment" },
  "Ctrl+/": { label: "Comment", command: "comment" },
  "Cmd+Z": { label: "Undo", command: "undo" },
  "Ctrl+Z": { label: "Undo", command: "undo" },
  "Cmd+Shift+Z": { label: "Redo", command: "redo" },
  "Ctrl+Shift+Z": { label: "Redo", command: "redo" },
  "Cmd+Y": { label: "Redo", command: "redo" },
  "Ctrl+Y": { label: "Redo", command: "redo" },
  "Cmd+Enter": { label: "Run", command: "run" },
  "Ctrl+Enter": { label: "Run", command: "run" },
  "Cmd+G": { label: "Go to Line", command: "go-to-line" },
  "Ctrl+G": { label: "Go to Line", command: "go-to-line" },
};

function isControlShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.repeat) return false;
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  if (!hasModifier) return false;
  const key = normalizeKey(event.key);
  if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return false;
  return key.length > 0 && key !== "Shift" && key !== "Control" && key !== "Alt" && key !== "Meta";
}

function shortcutKeys(event: KeyboardEvent): string[] {
  const keys: string[] = [];
  if (event.metaKey) keys.push("Cmd");
  if (event.ctrlKey) keys.push("Ctrl");
  if (event.shiftKey) keys.push("Shift");
  if (event.altKey) keys.push(isApplePlatform() ? "Option" : "Alt");
  const key = normalizeKey(event.key);
  if (key && !["Shift", "Control", "Alt", "Meta"].includes(key)) keys.push(key);
  return keys;
}

function normalizeKey(rawKey: string): string {
  if (!rawKey) return "";
  if (rawKey === " ") return "Space";
  if (rawKey.length === 1) return rawKey.toUpperCase();
  if (rawKey === "Esc") return "Escape";
  if (rawKey === "ArrowUp") return "↑";
  if (rawKey === "ArrowDown") return "↓";
  if (rawKey === "ArrowLeft") return "←";
  if (rawKey === "ArrowRight") return "→";
  return rawKey;
}

function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function listenerTargetForRoot(root: Window | HTMLElement | null): Window | null {
  if (!root) return null;
  if (isWindowRoot(root)) return root;
  return root.ownerDocument?.defaultView ?? null;
}

function isWindowRoot(root: Window | HTMLElement): root is Window {
  return !("ownerDocument" in root);
}

function isKeyboardEvent(event: Event): event is KeyboardEvent {
  return event.type === "keydown" && typeof (event as KeyboardEvent).key === "string";
}

function isNodeTarget(target: EventTarget | null): target is Node {
  return Boolean(target && typeof (target as Node).nodeType === "number");
}
