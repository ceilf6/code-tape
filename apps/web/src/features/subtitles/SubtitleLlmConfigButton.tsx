import { Settings } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Popover } from "@/shared/ui/Popover";
import { cn } from "@/shared/ui/utils/cn";
import {
  clearExternalLlmConfig,
  isExternalLlmConfigured,
  loadExternalLlmConfig,
  saveExternalLlmConfig,
  type ExternalLlmConfig,
  type ExternalLlmProvider,
} from "./subtitleLlmConfig";

export type SubtitleLlmConfigButtonProps = {
  configured: boolean;
  onConfigChange(): void;
};

const EMPTY_DRAFT: ExternalLlmConfig = {
  provider: "openai",
  baseURL: "",
  apiKey: "",
  model: "",
};

const inputClassName = cn(
  "w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
);

export function SubtitleLlmConfigButton({ configured, onConfigChange }: SubtitleLlmConfigButtonProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ExternalLlmConfig>(EMPTY_DRAFT);
  const fieldId = useId();

  useEffect(() => {
    if (open) setDraft(loadExternalLlmConfig() ?? EMPTY_DRAFT);
  }, [open]);

  const update = (patch: Partial<ExternalLlmConfig>) => setDraft((prev) => ({ ...prev, ...patch }));

  const handleSave = () => {
    if (!isExternalLlmConfigured(draft)) return;
    saveExternalLlmConfig(draft);
    onConfigChange();
    setOpen(false);
  };

  const handleClear = () => {
    clearExternalLlmConfig();
    setDraft(EMPTY_DRAFT);
    onConfigChange();
    setOpen(false);
  };

  const canSave = isExternalLlmConfigured(draft);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={280}
      trigger={
        <button
          type="button"
          aria-label={configured ? "外部大模型已配置，点击编辑" : "配置外部大模型"}
          aria-pressed={configured}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors",
            "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            configured ? "text-primary" : "text-muted",
          )}
        >
          <Settings aria-hidden size={15} />
        </button>
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <p className="font-medium text-foreground">外部大模型（字幕纠错）</p>
        <p className="text-[11px] leading-4 text-muted">
          配置后字幕优化优先用该模型，失败或未配置时回退本地模型。API Key 仅保存在本机浏览器；请填支持浏览器跨域（CORS）的请求地址。
        </p>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-provider`}>
          <span className="text-muted">请求方式</span>
          <select
            id={`${fieldId}-provider`}
            value={draft.provider}
            onChange={(event) => update({ provider: event.target.value as ExternalLlmProvider })}
            className={inputClassName}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="flex flex-col gap-1" htmlFor={`${fieldId}-base`}>
          <span className="text-muted">请求地址</span>
          <input
            id={`${fieldId}-base`}
            type="url"
            inputMode="url"
            placeholder={draft.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
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
            placeholder={draft.provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini"}
            value={draft.model}
            onChange={(event) => update({ model: event.target.value })}
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
