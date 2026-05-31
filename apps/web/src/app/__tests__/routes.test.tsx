import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { AppShell } from "../AppShell";
import { appRoutes } from "../routes";

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
});
