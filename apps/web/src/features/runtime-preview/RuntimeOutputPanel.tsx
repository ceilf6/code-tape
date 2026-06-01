import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";

export type RuntimeOutputPanelProps = {
  runtime: RuntimeOutputState;
};

export type RuntimeOutputState = {
  status: string;
  stdout: string[];
  stderr: string[];
  errorMessage: string | null;
};

type RuntimeOutputChannel = "all" | "stdout" | "stderr" | "error";
type RuntimeOutputEntry = {
  channel: Exclude<RuntimeOutputChannel, "all">;
  line: string;
};

const CHANNEL_OPTIONS: { value: RuntimeOutputChannel; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "stdout", label: "stdout" },
  { value: "stderr", label: "stderr" },
  { value: "error", label: "error" },
];

export function RuntimeOutputPanel({ runtime }: RuntimeOutputPanelProps) {
  const [selectedChannel, setSelectedChannel] = useState<RuntimeOutputChannel>("all");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const entries = useMemo(() => runtimeOutputEntries(runtime), [runtime]);
  const counts = {
    all: entries.length,
    stdout: runtime.stdout.length,
    stderr: runtime.stderr.length,
    error: runtime.errorMessage ? 1 : 0,
  };
  const visibleEntries =
    selectedChannel === "all"
      ? entries
      : entries.filter((entry) => entry.channel === selectedChannel);
  const hasOutput = entries.length > 0;
  const canCopy =
    hasOutput &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";
  const selectedLabel =
    CHANNEL_OPTIONS.find((option) => option.value === selectedChannel)?.label ?? "output";

  const copyOutput = async () => {
    if (!hasOutput) return;
    try {
      await navigator.clipboard.writeText(formatRuntimeOutput(entries));
      setCopyFeedback("输出已复制");
    } catch {
      setCopyFeedback("复制失败");
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col border-t border-border bg-background px-4 py-3"
      aria-label="Runtime output"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Console</h2>
          <p className="mt-1 text-[11px] text-muted">
            stdout {counts.stdout} · stderr {counts.stderr} · error {counts.error}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-sm border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
            {runtime.status}
          </span>
          <button
            type="button"
            aria-label="复制运行输出"
            title="复制运行输出"
            disabled={!canCopy}
            onClick={copyOutput}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-foreground/80 transition-[background-color,color] duration-150 ease-out-soft hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {copyFeedback === "输出已复制" ? (
              <Check aria-hidden size={14} />
            ) : (
              <Copy aria-hidden size={14} />
            )}
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1" aria-label="运行输出筛选">
        {CHANNEL_OPTIONS.map((option) => {
          const count = counts[option.value];
          const selected = selectedChannel === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              aria-label={`${option.label} ${count}`}
              className={[
                "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                selected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted hover:bg-surface hover:text-foreground",
              ].join(" ")}
              onClick={() => setSelectedChannel(option.value)}
            >
              <span>{option.label}</span>
              <span className="font-mono">{count}</span>
            </button>
          );
        })}
      </div>

      {copyFeedback ? (
        <p role="status" className="mb-2 text-[11px] text-muted">
          {copyFeedback}
        </p>
      ) : null}

      {visibleEntries.length > 0 ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto font-mono text-xs leading-5">
          {visibleEntries.map((entry, index) => (
            <pre
              key={`${entry.channel}-${index}`}
              className={[
                "whitespace-pre-wrap rounded-sm border border-border/70 bg-surface/40 px-2 py-1.5",
                outputTextClass(entry.channel),
              ].join(" ")}
            >
              <span className="select-none text-muted">[{entry.channel}] </span>
              <span>{entry.line}</span>
            </pre>
          ))}
        </div>
      ) : hasOutput ? (
        <p className="text-xs text-muted">{selectedLabel} 暂无输出</p>
      ) : (
        <p className="text-xs text-muted">暂无运行输出</p>
      )}
    </section>
  );
}

function runtimeOutputEntries(runtime: RuntimeOutputState): RuntimeOutputEntry[] {
  return [
    ...runtime.stdout.map((line) => ({ channel: "stdout" as const, line })),
    ...runtime.stderr.map((line) => ({ channel: "stderr" as const, line })),
    ...(runtime.errorMessage ? [{ channel: "error" as const, line: runtime.errorMessage }] : []),
  ];
}

function formatRuntimeOutput(entries: RuntimeOutputEntry[]): string {
  return entries.map((entry) => `[${entry.channel}] ${entry.line}`).join("\n");
}

function outputTextClass(channel: RuntimeOutputEntry["channel"]): string {
  switch (channel) {
    case "stdout":
      return "text-foreground";
    case "stderr":
      return "text-warning";
    case "error":
      return "text-danger";
  }
}
