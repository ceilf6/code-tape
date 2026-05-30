import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ClipboardList, Monitor, Radio } from "lucide-react";
import { parseInterviewerLink } from "./interviewerLink";

export function InterviewLobbyPage() {
  const navigate = useNavigate();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleJoin = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseInterviewerLink(link);
    if (!parsed.ok) {
      setError("链接无效，请粘贴面试官完整链接（含 joinCode）。");
      return;
    }
    setError(null);
    navigate(
      `/interview/interviewer/${encodeURIComponent(parsed.roomId)}?joinCode=${encodeURIComponent(
        parsed.joinCode,
      )}`,
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background px-4 py-8 text-foreground">
      <div className="mx-auto my-auto w-full max-w-3xl">
        <div className="flex items-center gap-2">
          <Radio aria-hidden size={20} className="text-primary" />
          <h1 className="font-display text-xl font-semibold">实时面试</h1>
        </div>
        <p className="mt-2 text-sm text-muted">
          选择你的角色加入这场远程面试：候选人发起房间并录制讲解，面试官通过分享链接实时旁观并语音视频沟通。
        </p>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center gap-2">
              <ClipboardList aria-hidden size={18} className="text-primary" />
              <h2 className="text-base font-semibold">我是候选人</h2>
            </div>
            <p className="mt-2 flex-1 text-sm leading-6 text-muted">
              发起一场面试，系统会创建房间并生成可分享给面试官的链接。你照常录制代码讲解，操作会实时同步给面试官。
            </p>
            <button
              type="button"
              onClick={() => navigate("/interview/candidate")}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              发起面试
              <ArrowRight aria-hidden size={16} />
            </button>
          </section>

          <section className="flex flex-col rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center gap-2">
              <Monitor aria-hidden size={18} className="text-primary" />
              <h2 className="text-base font-semibold">我是面试官</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted">
              粘贴候选人分享的面试官链接（含 joinCode），加入后即可只读查看候选人编辑器并进行双向音视频通话。
            </p>
            <form className="mt-4 flex flex-col gap-2" onSubmit={handleJoin}>
              <label htmlFor="interviewer-link" className="text-xs font-medium text-muted">
                面试官链接
              </label>
              <input
                id="interviewer-link"
                type="text"
                value={link}
                onChange={(event) => {
                  setLink(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="https://…/interview/interviewer/<房间>?joinCode=…"
                className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted focus:border-primary"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "interviewer-link-error" : undefined}
              />
              {error ? (
                <p id="interviewer-link-error" role="alert" className="text-xs text-danger">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                className="mt-1 inline-flex items-center justify-center gap-2 rounded-md border border-border bg-surface-raised px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised/80"
              >
                加入面试
                <ArrowRight aria-hidden size={16} />
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
