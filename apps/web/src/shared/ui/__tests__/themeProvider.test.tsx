import { describe, expect, it, beforeEach } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { ThemeProvider } from "../themeProvider";
import { useTheme } from "../useTheme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.theme = "";
});

function installColorSchemeMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<EventListener>();
  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null as EventListener | null,
    addListener: (listener: EventListener) => listeners.add(listener),
    removeListener: (listener: EventListener) => listeners.delete(listener),
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    dispatchEvent: (event: Event) => {
      listeners.forEach((listener) => listener.call(mediaQueryList, event));
      mediaQueryList.onchange?.call(mediaQueryList, event);
      return true;
    },
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches;
      mediaQueryList.dispatchEvent(new Event("change"));
    },
  };

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) =>
      query === "(prefers-color-scheme: dark)"
        ? mediaQueryList
        : {
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          },
  });

  return mediaQueryList;
}

describe("ThemeProvider", () => {
  it("defaults to system preference and resolves to dark when matchMedia returns dark", () => {
    installColorSchemeMatchMedia(true);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("persists preference to localStorage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    act(() => result.current.setPreference("light"));
    expect(window.localStorage.getItem("code-tape:theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggle flips between resolved themes", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    act(() => result.current.setPreference("dark"));
    expect(result.current.resolved).toBe("dark");
    act(() => result.current.toggle());
    expect(result.current.resolved).toBe("light");
  });

  it("updates the resolved system theme when the color scheme media query changes", () => {
    const colorScheme = installColorSchemeMatchMedia(true);

    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => colorScheme.setMatches(false));

    expect(result.current.preference).toBe("system");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("throws when used outside provider", () => {
    function Probe() {
      useTheme();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/inside <ThemeProvider>/);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
