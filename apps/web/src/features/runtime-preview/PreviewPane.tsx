import { useEffect, useRef } from "react";
import { RefreshCcw } from "lucide-react";
import type { IframeRuntime } from "@/shared/recording-schema";
import { IconButton } from "@/shared/ui";

export type PreviewPaneProps = {
  runtime: IframeRuntime;
  /**
   * When provided (replay mode), the pane will call `runtime.renderPreview(html)`
   * to inject historical DOM instead of executing live code.
   */
  previewHtml?: string | null;
  onReset?: () => void;
  /** Hide the reset control for read-only consumers (e.g. interviewer view). */
  showReset?: boolean;
  className?: string;
};

/**
 * PreviewPane — hosts the iframe sandbox managed by IframeRuntime.
 *
 * STUB. Real implementation belongs to issue
 * `[P0] PreviewPane 渲染 IframeRuntime 输出`.
 *
 * 实装要点：
 *   - useEffect: runtime.mount(hostRef.current) on first render
 *   - useEffect 监听 previewHtml 变化 → runtime.renderPreview(html)
 *   - cleanup: runtime.destroy()
 *   - 外部 padding=0；让 iframe 100%/100% 填满，避免运行时坐标偏移
 *   - 灰底 + checker pattern 作为「未运行」占位
 */
export function PreviewPane({ runtime, previewHtml, onReset, showReset = true, className }: PreviewPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    void runtime.mount(hostRef.current);
    return () => runtime.destroy();
  }, [runtime]);

  useEffect(() => {
    if (typeof previewHtml === "string") {
      void runtime.renderPreview(previewHtml);
    }
  }, [previewHtml, runtime]);

  return (
    <div
      ref={hostRef}
      className={["relative h-full w-full bg-surface", className].filter(Boolean).join(" ")}
      aria-label="Runtime preview pane"
    >
      {showReset ? (
        <div className="absolute right-2 top-2 z-10">
          <IconButton
            label="重置预览"
            icon={<RefreshCcw size={15} />}
            size="sm"
            variant="subtle"
            onClick={() => {
              runtime.reset();
              onReset?.();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
