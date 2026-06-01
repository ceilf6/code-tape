import { Mic } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Popover } from "@/shared/ui/Popover";
import { cn } from "@/shared/ui/utils/cn";
import {
  clearExternalAsrConfig,
  isExternalAsrConfigured,
  loadExternalAsrConfig,
  saveExternalAsrConfig,
  type ExternalAsrConfig,
} from "./subtitleAsrConfig";

export type SubtitleAsrConfigButtonProps = {
  configured: boolean;
  onConfigChange(): void;
};

const EMPTY_DRAFT: ExternalAsrConfig = {
  provider: "openai-compatible",
  baseURL: "",
  apiKey: "",
  model: "",
  language: "zh",
};

const inputClassName = cn(
  "w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
);

export function SubtitleAsrConfigButton({
  configured,
  onConfigChange,
}: SubtitleAsrConfigButtonProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ExternalAsrConfig>(EMPTY_DRAFT);
  const fieldId = useId();

  useEffect(() => {
    if (open) setDraft(loadExternalAsrConfig() ?? EMPTY_DRAFT);
  }, [open]);

  const update = (patch: Partial<ExternalAsrConfig>) => setDraft((prev) => ({ ...prev, ...patch }));

  const handleSave = () => {
    if (!isExternalAsrConfigured(draft)) return;
    saveExternalAsrConfig(draft);
    onConfigChange();
    setOpen(false);
  };

  const handleClear = () => {
    clearExternalAsrConfig();
    setDraft(EMPTY_DRAFT);
    onConfigChange();
    setOpen(false);
  };

  const canSave = isExternalAsrConfigured(draft);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={280}
      trigger={
        <button
          type="button"
          aria-label={configured ? "外部 ASR 已配置，点击编辑" : "配置外部 ASR"}
          aria-pressed={configured}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            configured ? "text-primary" : "text-muted",
          )}
        >
          <Mic aria-hidden size={15} />
        </button>
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <p className="font-medium text-foreground">外部 ASR（语音转字幕）</p>
        <p className="text-[11px] leading-4 text-muted">
          配置后优先请求 OpenAI-compatible /audio/transcriptions，失败时回退本地 ASR。API Key
          仅保存在本机浏览器；请填支持浏览器跨域（CORS）的请求地址。
        </p>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-base`}>
          <span className="text-muted">请求地址</span>
          <input
            id={`${fieldId}-base`}
            type="url"
            inputMode="url"
            placeholder="https://api.openai.com/v1"
            value={draft.baseURL}
            onChange={(event) => update({ baseURL: event.target.value })}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-key`}>
          <span className="text-muted">API Key</span>
          <input
            id={`${fieldId}-key`}
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-model`}>
          <span className="text-muted">Model</span>
          <input
            id={`${fieldId}-model`}
            type="text"
            placeholder="gpt-4o-mini-transcribe"
            value={draft.model}
            onChange={(event) => update({ model: event.target.value })}
            className={inputClassName}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-language`}>
          <span className="text-muted">语言</span>
          <input
            id={`${fieldId}-language`}
            type="text"
            placeholder="zh"
            value={draft.language}
            onChange={(event) => update({ language: event.target.value })}
            className={inputClassName}
          />
        </label>
        <div className="mt-1 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleClear}
            className="rounded-md px-2 py-1 text-muted transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            清除
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              "rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground transition-opacity",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              canSave ? "hover:opacity-90" : "cursor-not-allowed opacity-50",
            )}
          >
            保存
          </button>
        </div>
      </div>
    </Popover>
  );
}
