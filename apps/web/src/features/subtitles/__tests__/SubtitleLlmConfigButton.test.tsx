import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleLlmConfigButton } from "../SubtitleLlmConfigButton";
import { SUBTITLE_LLM_CONFIG_STORAGE_KEY, loadExternalLlmConfig } from "../subtitleLlmConfig";

describe("SubtitleLlmConfigButton", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("saves a complete config and notifies the parent", () => {
    const onConfigChange = vi.fn();
    render(<SubtitleLlmConfigButton configured={false} onConfigChange={onConfigChange} />);

    fireEvent.click(screen.getByRole("button", { name: "配置外部大模型" }));
    fireEvent.change(screen.getByLabelText("请求地址"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(loadExternalLlmConfig()).toEqual({
      provider: "openai",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    });
  });

  it("disables save until all fields are filled", () => {
    render(<SubtitleLlmConfigButton configured={false} onConfigChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "配置外部大模型" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("clears an existing config", () => {
    window.localStorage.setItem(
      SUBTITLE_LLM_CONFIG_STORAGE_KEY,
      JSON.stringify({ provider: "openai", baseURL: "https://x", apiKey: "k", model: "m" }),
    );
    const onConfigChange = vi.fn();
    render(<SubtitleLlmConfigButton configured onConfigChange={onConfigChange} />);

    fireEvent.click(screen.getByRole("button", { name: "外部大模型已配置，点击编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    expect(loadExternalLlmConfig()).toBeNull();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
  });

  it("shows the API key / CORS risk hint", () => {
    render(<SubtitleLlmConfigButton configured={false} onConfigChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "配置外部大模型" }));
    expect(screen.getByText(/API Key 仅保存在本机浏览器/)).toBeInTheDocument();
    expect(screen.getByText(/跨域/)).toBeInTheDocument();
  });
});
