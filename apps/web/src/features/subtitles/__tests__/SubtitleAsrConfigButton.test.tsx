import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleAsrConfigButton } from "../SubtitleAsrConfigButton";
import { SUBTITLE_ASR_CONFIG_STORAGE_KEY, loadExternalAsrConfig } from "../subtitleAsrConfig";

describe("SubtitleAsrConfigButton", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("saves a complete external ASR config and notifies the parent", () => {
    const onConfigChange = vi.fn();
    render(<SubtitleAsrConfigButton configured={false} onConfigChange={onConfigChange} />);

    fireEvent.click(screen.getByRole("button", { name: "配置外部 ASR" }));
    fireEvent.change(screen.getByLabelText("请求地址"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o-mini-transcribe" },
    });
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(loadExternalAsrConfig()).toEqual({
      provider: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini-transcribe",
      language: "zh",
    });
  });

  it("clears an existing config", () => {
    window.localStorage.setItem(
      SUBTITLE_ASR_CONFIG_STORAGE_KEY,
      JSON.stringify({
        provider: "openai-compatible",
        baseURL: "https://x",
        apiKey: "k",
        model: "m",
        language: "",
      }),
    );
    const onConfigChange = vi.fn();
    render(<SubtitleAsrConfigButton configured onConfigChange={onConfigChange} />);

    fireEvent.click(screen.getByRole("button", { name: "外部 ASR 已配置，点击编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    expect(loadExternalAsrConfig()).toBeNull();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
  });
});
