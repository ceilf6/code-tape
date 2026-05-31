import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "./utils/cn";

const DEFAULT_LEFT_PERCENT = 68;
const DEFAULT_MIN_LEFT_PERCENT = 52;
const DEFAULT_MAX_LEFT_PERCENT = 78;
const DEFAULT_STEP = 4;

export type ResizableWorkspaceProps = {
  ariaLabel: string;
  separatorLabel: string;
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
  defaultLeftPercent?: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
  step?: number;
};

export function ResizableWorkspace({
  ariaLabel,
  separatorLabel,
  storageKey,
  left,
  right,
  className,
  leftClassName,
  rightClassName,
  defaultLeftPercent = DEFAULT_LEFT_PERCENT,
  minLeftPercent = DEFAULT_MIN_LEFT_PERCENT,
  maxLeftPercent = DEFAULT_MAX_LEFT_PERCENT,
  step = DEFAULT_STEP,
}: ResizableWorkspaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [leftPercent, setLeftPercent] = useState(() =>
    readStoredPercent(storageKey, defaultLeftPercent, minLeftPercent, maxLeftPercent, step),
  );
  const layoutStyle = useMemo(
    () => ({ "--workspace-left": `${leftPercent}%` }) as CSSProperties,
    [leftPercent],
  );

  const commitPercent = useCallback(
    (nextPercent: number) => {
      const clamped = clampToStep(nextPercent, minLeftPercent, maxLeftPercent, step);
      setLeftPercent(clamped);
      persistPercent(storageKey, clamped);
    },
    [maxLeftPercent, minLeftPercent, step, storageKey],
  );

  const commitPointerPosition = useCallback(
    (clientX: number) => {
      if (!Number.isFinite(clientX)) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      commitPercent(((clientX - rect.left) / rect.width) * 100);
    },
    [commitPercent],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    commitPointerPosition(event.clientX);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    commitPointerPosition(event.clientX);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keyActions: Record<string, number> = {
      ArrowLeft: leftPercent - step,
      ArrowDown: leftPercent - step,
      ArrowRight: leftPercent + step,
      ArrowUp: leftPercent + step,
      Home: minLeftPercent,
      End: maxLeftPercent,
    };
    const nextPercent = keyActions[event.key];
    if (nextPercent === undefined) return;
    event.preventDefault();
    commitPercent(nextPercent);
  };

  return (
    <div
      ref={containerRef}
      aria-label={ariaLabel}
      className={cn("flex min-h-0 flex-1 flex-col md:flex-row", className)}
      style={layoutStyle}
    >
      <div
        className={cn(
          "min-h-0 md:min-w-0 md:basis-[var(--workspace-left)] md:shrink-0 md:grow-0",
          leftClassName,
        )}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-label={separatorLabel}
        aria-orientation="vertical"
        aria-valuemin={minLeftPercent}
        aria-valuemax={maxLeftPercent}
        aria-valuenow={leftPercent}
        aria-valuetext={`${leftPercent}%`}
        tabIndex={0}
        className={cn(
          "group hidden w-3 shrink-0 cursor-col-resize touch-none items-stretch justify-center outline-none md:flex",
          "focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <span className="my-3 w-px rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className={cn("min-h-0 md:min-w-0 md:flex-1", rightClassName)}>{right}</div>
    </div>
  );
}

function readStoredPercent(
  storageKey: string,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  if (typeof window === "undefined") return clampToStep(fallback, min, max, step);
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return clampToStep(fallback, min, max, step);
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampToStep(parsed, min, max, step) : clampToStep(fallback, min, max, step);
  } catch {
    return clampToStep(fallback, min, max, step);
  }
}

function persistPercent(storageKey: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    // Ignore storage failures in private/sandboxed contexts; resizing still works for the session.
  }
}

function clampToStep(value: number, min: number, max: number, step: number): number {
  const stepped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, stepped));
}
