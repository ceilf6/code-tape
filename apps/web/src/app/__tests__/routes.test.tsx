import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { AppShell } from "../AppShell";
import { appRoutes } from "../routes";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.theme = "";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("appRoutes", () => {
  it("registers cloud replay routes", () => {
    const childPaths = appRoutes[0]?.children?.map((route) => route.path) ?? [];

    expect(childPaths).toContain("replays/:id");
    expect(childPaths).toContain("cloud/replay/:id");
    expect(childPaths).toContain("s/:token");
  });

  it("registers the interview lobby route", () => {
    const childPaths = appRoutes[0]?.children?.map((route) => route.path) ?? [];

    expect(childPaths).toContain("interview");
  });
});

describe("AppShell", () => {
  it("uses the uppercase wordmark in the top navigation", () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByText("CODE-TAPE")).toBeInTheDocument();
    expect(screen.queryByText("code-tape")).not.toBeInTheDocument();
  });

  it("exposes the interview lobby entry in the top navigation", () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>,
    );

    expect(screen.getByRole("link", { name: "面试" })).toHaveAttribute("href", "/interview");
  });

  it("lets users choose system, light, and dark theme preferences", () => {
    render(
      <ThemeProvider>
        <MemoryRouter>
          <AppShell />
        </MemoryRouter>
      </ThemeProvider>,
    );

    const systemButton = screen.getByRole("button", { name: "跟随系统主题" });
    const lightButton = screen.getByRole("button", { name: "切换到浅色主题" });
    const darkButton = screen.getByRole("button", { name: "切换到深色主题" });

    expect(screen.getByRole("group", { name: "主题偏好，当前偏好：跟随系统，当前生效：深色" })).toBeInTheDocument();
    expect(systemButton).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(lightButton);
    expect(screen.getByRole("group", { name: "主题偏好，当前偏好：浅色，当前生效：浅色" })).toBeInTheDocument();
    expect(lightButton).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("code-tape:theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(darkButton);
    expect(screen.getByRole("group", { name: "主题偏好，当前偏好：深色，当前生效：深色" })).toBeInTheDocument();
    expect(darkButton).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("code-tape:theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(systemButton);
    expect(screen.getByRole("group", { name: "主题偏好，当前偏好：跟随系统，当前生效：深色" })).toBeInTheDocument();
    expect(systemButton).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("code-tape:theme")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
