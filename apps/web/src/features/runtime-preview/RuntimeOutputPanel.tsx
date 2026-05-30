import type { ReplayStableState } from "@/shared/recording-schema";

export type RuntimeOutputPanelProps = {
  runtime: ReplayStableState["runtime"];
};

export function RuntimeOutputPanel({ runtime }: RuntimeOutputPanelProps) {
  const hasOutput = runtime.stdout.length > 0 || runtime.stderr.length > 0 || runtime.errorMessage;

  return (
    <section className="border-t border-border bg-background px-4 py-3" aria-label="Runtime output">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Console</h2>
        <span className="rounded-sm border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
          {runtime.status}
        </span>
      </div>
      {hasOutput ? (
        <div className="max-h-40 space-y-2 overflow-auto font-mono text-xs leading-5">
          {runtime.stdout.map((line, index) => (
            <pre key={`stdout-${index}`} className="whitespace-pre-wrap text-foreground">
              {line}
            </pre>
          ))}
          {runtime.stderr.map((line, index) => (
            <pre key={`stderr-${index}`} className="whitespace-pre-wrap text-warning">
              {line}
            </pre>
          ))}
          {runtime.errorMessage ? (
            <pre className="whitespace-pre-wrap text-danger">{runtime.errorMessage}</pre>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">No output</p>
      )}
    </section>
  );
}
