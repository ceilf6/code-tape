import {
  buildFinalReplayStateFromPackage,
  type RecordingPackageV1,
  type ReplayStableState,
} from "@/shared/recording-schema";
import type { VideoThumbnailOptions } from "./videoThumbnail";

export async function createReplayThumbnail(
  pkg: RecordingPackageV1,
  options: VideoThumbnailOptions,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  if (isJsdomCanvasWithoutImplementation(canvas)) return null;
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  drawReplayFrame(context, buildFinalReplayStateFromPackage(pkg), canvas.width, canvas.height);
  return canvasToBlob(canvas, options.mimeType, options.quality);
}

function drawReplayFrame(
  context: CanvasRenderingContext2D,
  state: ReplayStableState,
  width: number,
  height: number,
) {
  const dark = state.editor.theme === "dark";
  const palette = dark
    ? {
        page: "#111827",
        panel: "#1f2937",
        rail: "#374151",
        text: "#f9fafb",
        muted: "#9ca3af",
        accent: "#38bdf8",
        preview: "#0f172a",
      }
    : {
        page: "#f8fafc",
        panel: "#ffffff",
        rail: "#e5e7eb",
        text: "#111827",
        muted: "#64748b",
        accent: "#0284c7",
        preview: "#f1f5f9",
      };

  context.fillStyle = palette.page;
  context.fillRect(0, 0, width, height);

  const margin = Math.round(width * 0.045);
  const gap = Math.round(width * 0.035);
  const editorWidth = Math.round(width * 0.62);
  const panelWidth = width - margin * 2 - gap - editorWidth;
  const panelHeight = height - margin * 2;

  fillRoundRect(context, margin, margin, editorWidth, panelHeight, 8, palette.panel);
  fillRoundRect(context, margin + editorWidth + gap, margin, panelWidth, panelHeight, 8, palette.preview);

  context.fillStyle = palette.rail;
  context.fillRect(margin, margin, editorWidth, 18);
  context.fillRect(margin + editorWidth + gap, margin, panelWidth, 18);
  context.fillStyle = palette.accent;
  context.fillRect(margin, margin + 17, editorWidth, 1);

  context.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = palette.muted;
  context.fillText(state.editor.language.toUpperCase(), margin + 12, margin + 13);
  context.fillText("OUTPUT", margin + editorWidth + gap + 12, margin + 13);

  context.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = palette.text;
  drawCodeLines(context, state.editor.code, margin + 12, margin + 38, editorWidth - 24, 17, 7, palette.text);

  context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = state.runtime.status === "error" ? "#ef4444" : palette.text;
  const outputText = replayOutputText(state) || "No output";
  drawWrappedText(context, outputText, margin + editorWidth + gap + 12, margin + 42, panelWidth - 24, 16, 6);
}

function drawCodeLines(
  context: CanvasRenderingContext2D,
  code: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  textColor: string,
) {
  const lines = code.trim() ? code.split(/\r?\n/) : ["// Empty recording"];
  const lineNumberWidth = 26;
  context.textBaseline = "top";
  for (let index = 0; index < Math.min(lines.length, maxLines); index += 1) {
    context.fillStyle = "rgba(148, 163, 184, 0.85)";
    context.fillText(String(index + 1), x, y + index * lineHeight);
    context.fillStyle = textColor;
    drawEllipsizedText(context, lines[index], x + lineNumberWidth, y + index * lineHeight, maxWidth - lineNumberWidth);
  }
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const chunks = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const chunk of chunks) {
    const next = current ? `${current} ${chunk}` : chunk;
    if (context.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = chunk;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) lines.push(text.slice(0, 32));
  context.textBaseline = "top";
  lines.slice(0, maxLines).forEach((line, index) => {
    drawEllipsizedText(context, line, x, y + index * lineHeight, maxWidth);
  });
}

function drawEllipsizedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  if (context.measureText(text).width <= maxWidth) {
    context.fillText(text, x, y);
    return;
  }
  let clipped = text;
  while (clipped.length > 1 && context.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  context.fillText(`${clipped}...`, x, y);
}

function fillRoundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string,
) {
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fill();
}

function replayOutputText(state: ReplayStableState): string {
  return [
    ...state.runtime.stdout,
    ...state.runtime.stderr,
    state.runtime.errorMessage ?? "",
  ]
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

function isJsdomCanvasWithoutImplementation(canvas: HTMLCanvasElement): boolean {
  return (
    typeof navigator !== "undefined" &&
    /\bjsdom\b/i.test(navigator.userAgent) &&
    typeof HTMLCanvasElement !== "undefined" &&
    canvas instanceof HTMLCanvasElement
  );
}
