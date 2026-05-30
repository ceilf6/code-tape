import { Outlet, NavLink } from "react-router-dom";
import { useTheme } from "@/shared/ui/useTheme";

/**
 * AppShell — top-level chrome that hosts page outlets.
 *
 * Slim navigation strip + theme toggle. Pages own the rest of the viewport so
 * recorder/replay can show their full workshop layout.
 */
export function AppShell() {
  const theme = useTheme();
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-12 items-center gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur">
        <span className="font-display text-sm font-semibold tracking-tight">code-tape</span>
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
        <button
          type="button"
          onClick={theme.toggle}
          className="rounded-md border border-border bg-surface px-3 py-1 text-xs text-muted hover:text-foreground"
        >
          {theme.resolved === "dark" ? "☾ Dark" : "☀ Light"}
        </button>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
