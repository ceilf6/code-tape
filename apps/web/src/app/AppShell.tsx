import { Outlet, NavLink } from "react-router-dom";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeMode, ThemePreference } from "@/shared/ui";
import { useTheme } from "@/shared/ui/useTheme";

const THEME_PREFERENCE_LABEL: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
};

/**
 * AppShell — top-level chrome that hosts page outlets.
 *
 * Slim navigation strip + theme toggle. Pages own the rest of the viewport so
 * recorder/replay can show their full workshop layout.
 */
export function AppShell() {
  const theme = useTheme();
  const themeStatusLabel = `主题偏好，当前偏好：${THEME_PREFERENCE_LABEL[theme.preference]}，当前生效：${THEME_MODE_LABEL[theme.resolved]}`;
  const themeOptions: Array<{
    preference: ThemePreference;
    label: string;
    ariaLabel: string;
    icon: typeof Monitor;
  }> = [
    { preference: "system", label: "系统", ariaLabel: "跟随系统主题", icon: Monitor },
    { preference: "light", label: "浅色", ariaLabel: "切换到浅色主题", icon: Sun },
    { preference: "dark", label: "深色", ariaLabel: "切换到深色主题", icon: Moon },
  ];

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 items-center gap-2 border-b border-border bg-surface/80 px-2 backdrop-blur sm:gap-4 sm:px-4">
        <span className="font-display text-xs font-semibold tracking-[0.24em]">CODE-TAPE</span>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              [
                "rounded-md px-2 py-1 transition-colors",
                isActive ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground",
              ].join(" ")
            }
          >
            库
          </NavLink>
          <NavLink
            to="/record"
            className={({ isActive }) =>
              [
                "rounded-md px-2 py-1 transition-colors",
                isActive ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground",
              ].join(" ")
            }
          >
            录制
          </NavLink>
          <NavLink
            to="/interview"
            className={({ isActive }) =>
              [
                "rounded-md px-2 py-1 transition-colors",
                isActive ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground",
              ].join(" ")
            }
          >
            面试
          </NavLink>
        </nav>
        <span className="flex-1" />
        <div
          aria-label={themeStatusLabel}
          className="grid grid-cols-3 overflow-hidden rounded-md border border-border bg-surface p-0.5"
          role="group"
        >
          {themeOptions.map((option) => {
            const Icon = option.icon;
            const selected = theme.preference === option.preference;
            return (
              <button
                key={option.preference}
                type="button"
                aria-label={option.ariaLabel}
                aria-pressed={selected}
                onClick={() => theme.setPreference(option.preference)}
                className={[
                  "inline-flex h-7 w-8 items-center justify-center gap-1 rounded-[5px] text-xs transition-colors sm:w-auto sm:min-w-14 sm:px-2",
                  selected
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted hover:bg-surface-raised hover:text-foreground",
                ].join(" ")}
              >
                <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{option.label}</span>
              </button>
            );
          })}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
