import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Share2 } from "lucide-react";
import { downloadBlob, safeFilenameStem } from "./recordingDownload";
import { createRecordingStore } from "./recordingStore";
import { createCloudRecordingRepository } from "@/features/cloud/cloudRecordingRepository";
import type { CloudApiError, CloudRecordingListItem } from "@/features/cloud/types";
import { formatDurationMs } from "@/shared/time/duration";
import { IconButton, Popover, Tooltip } from "@/shared/ui";
import type { PackageLoadError, RecordingListItem, SaveResult } from "@/shared/recording-schema";

type LibraryItem = RecordingListItem | CloudRecordingListItem;

/**
 * RecordingLibraryPage — wires the RecordingRepository and lists completed
 * recordings.
 *
 * The card grid layout, search/filter UI, thumbnail rendering, and zip
 * import/export buttons are delegated to issue
 * `[P0] RecordingLibraryPage 列表 UI`. This shell guarantees the data layer
 * works and supplies the minimum entries (open, rename, delete, export).
 */
export function RecordingLibraryPage() {
  const navigate = useNavigate();
  const localRepository = useMemo(() => createRecordingStore(), []);
  const cloudRepository = useMemo(() => createCloudRecordingRepository(), []);
  const [view, setView] = useState<"local" | "cloud">("local");
  const [localItems, setLocalItems] = useState<RecordingListItem[]>([]);
  const [cloudItems, setCloudItems] = useState<CloudRecordingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackDialog, setFeedbackDialog] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);
  const [pendingRenameValue, setPendingRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [quota, setQuota] = useState<{ usageBytes: number; quotaBytes: number } | null>(null);
  const [localThumbnailUrls, setLocalThumbnailUrls] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState<{ recordingId: string; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshLocal = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    let loadError: string | null = null;
    try {
      const list = await localRepository.list();
      setLocalItems(list);
      setLoadError(null);
    } catch (err) {
      loadError = `读取失败：${(err as Error).message}`;
      setLoadError(loadError);
    } finally {
      setLoading(false);
    }
    if (loadError) {
      setTimeout(() => {
        setFeedbackDialog({ tone: "error", message: loadError as string });
      }, 0);
    }
  }, [localRepository]);

  const refreshCloud = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    let loadError: string | null = null;
    try {
      const result = await cloudRepository.list();
      if (!result.ok) {
        throw new Error(formatCloudError(result.error));
      }
      setCloudItems(result.value.items);
      setLoadError(null);
    } catch (err) {
      loadError = `读取云端失败：${(err as Error).message}`;
      setLoadError(loadError);
    } finally {
      setLoading(false);
    }
    if (loadError) {
      setTimeout(() => {
        setFeedbackDialog({ tone: "error", message: loadError as string });
      }, 0);
    }
  }, [cloudRepository]);

  const refresh = useCallback(async () => {
    if (view === "cloud") {
      await refreshCloud();
      return;
    }
    await refreshLocal();
  }, [refreshCloud, refreshLocal, view]);

  const refreshQuota = useCallback(async () => {
    try {
      const estimate = await localRepository.estimateQuota();
      setQuota(estimate.quotaBytes > 0 ? estimate : null);
    } catch {
      setQuota(null);
    }
  }, [localRepository]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshQuota();
    void localRepository.sweep().catch(() => {
      // Sweep failure should not block library rendering.
    });
  }, [refreshQuota, localRepository]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    if (view !== "local" || localItems.length === 0) {
      setLocalThumbnailUrls({});
      return () => {};
    }

    void Promise.all(
      localItems.map(async (item) => {
        if (!item.thumbnailBlobId) return null;
        try {
          const thumbnail = await localRepository.loadThumbnail(item.thumbnailBlobId);
          if (!thumbnail) return null;
          const url = URL.createObjectURL(thumbnail);
          createdUrls.push(url);
          return [item.id, url] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      const nextUrls = Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null));
      if (cancelled) {
        Object.values(nextUrls).forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      setLocalThumbnailUrls(nextUrls);
    });

    return () => {
      cancelled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [localItems, localRepository, view]);

  const handleDelete = async (item: LibraryItem) => {
    setBusyKey(`delete-${item.id}`);
    setDeleteError(null);
    try {
      if (view === "cloud") {
        const result = await cloudRepository.remove(item.id);
        if (!result.ok) throw new Error(formatCloudError(result.error));
      } else {
        await localRepository.remove(item.id);
      }
      setPendingDeleteId(null);
      await refresh();
      if (view === "local") await refreshQuota();
    } catch (err) {
      setDeleteError(`删除失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRenameStart = (item: LibraryItem) => {
    setPendingRenameId(item.id);
    setPendingRenameValue(item.title);
    setRenameError(null);
  };

  const handleRenameCancel = () => {
    setPendingRenameId(null);
    setPendingRenameValue("");
    setRenameError(null);
  };

  const handleRenameSubmit = async (item: LibraryItem) => {
    const nextTitle = pendingRenameValue.trim();
    if (!nextTitle) {
      setRenameError("标题不能为空。");
      return;
    }
    if (nextTitle === item.title) {
      handleRenameCancel();
      return;
    }
    setBusyKey(`rename-${item.id}`);
    try {
      if (view === "cloud") {
        const result = await cloudRepository.rename(item.id, nextTitle);
        if (!result.ok) throw new Error(formatCloudError(result.error));
      } else {
        await localRepository.rename(item.id, nextTitle);
      }
      handleRenameCancel();
      await refresh();
    } catch (err) {
      setRenameError(`重命名失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExport = async (item: RecordingListItem) => {
    setBusyKey(`export-${item.id}`);
    try {
      const zipBlob = await localRepository.exportZip(item.id);
      downloadBlob(zipBlob, `${safeFilenameStem(item.title, item.id)}.zip`);
      openFeedbackDialog("success", `已导出「${item.title}」。`);
    } catch (err) {
      openFeedbackDialog("error", `导出失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleShare = async (item: CloudRecordingListItem) => {
    setBusyKey(`share-${item.id}`);
    try {
      const result = await cloudRepository.createShareLink(item.id, {});
      if (!result.ok) throw new Error(formatCloudError(result.error));
      await writeClipboard(buildAbsoluteShareUrl(result.value.url));
      openFeedbackDialog("success", "分享链接已复制。");
    } catch (err) {
      openFeedbackDialog("error", `分享失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const imported = await localRepository.importZip(file);
      if (!imported.ok) {
        openFeedbackDialog("error", buildImportErrorMessage(imported));
        return;
      }
      openFeedbackDialog("success", `导入成功：${file.name}`);
      await refresh();
      await refreshQuota();
    } catch (err) {
      openFeedbackDialog("error", `导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleUpload = async (item: RecordingListItem) => {
    setBusyKey(`upload-${item.id}`);
    setUploadProgress({ recordingId: item.id, message: "准备上传…" });
    try {
      const loaded = await localRepository.load(item.id);
      if (!loaded.ok) {
        throw new Error(`本地录制包读取失败：${formatPackageLoadError(loaded.error)}`);
      }
      const thumbnail = item.thumbnailBlobId
        ? await localRepository.loadThumbnail(item.thumbnailBlobId).catch(() => null)
        : null;
      const blobs: { media?: Blob; thumbnail?: Blob } = {};
      if (loaded.mediaBlob) blobs.media = loaded.mediaBlob;
      if (thumbnail) blobs.thumbnail = thumbnail;
      const upload = await cloudRepository.uploadPackage(
        loaded.package,
        blobs,
        {
          timeoutMs: 60_000,
          onProgress: (progress) => {
            setUploadProgress({
              recordingId: item.id,
              message: formatUploadProgress(progress.bytesUploaded, progress.totalBytes),
            });
          },
        },
      );
      if (!upload.ok) throw new Error(formatCloudError(upload.error));

      setUploadProgress({ recordingId: item.id, message: "云端校验中…" });
      const ready = await cloudRepository.pollUntilReady(upload.value.recordingId, {
        intervalMs: 1_000,
        timeoutMs: 60_000,
      });
      if (!ready.ok) throw new Error(formatCloudError(ready.error));
      if (ready.value.recording.status === "failed") {
        throw new Error(
          ready.value.recording.failureMessage ??
            ready.value.recording.failureCode ??
            "云端校验失败",
        );
      }

      openFeedbackDialog("success", `已上传「${item.title}」。`);
      setView("cloud");
    } catch (err) {
      openFeedbackDialog("error", `上传失败：${(err as Error).message}`);
    } finally {
      setUploadProgress(null);
      setBusyKey(null);
    }
  };

  const quotaLabel = useMemo(() => {
    if (!quota || quota.quotaBytes <= 0) return null;
    const usageMB = (quota.usageBytes / (1024 * 1024)).toFixed(1);
    const quotaMB = (quota.quotaBytes / (1024 * 1024)).toFixed(1);
    const ratio = Math.round((quota.usageBytes / quota.quotaBytes) * 100);
    return `本地存储 ${usageMB} / ${quotaMB} MB (${ratio}%)`;
  }, [quota]);

  const items = view === "cloud" ? cloudItems : localItems;
  const canImport = view === "local" && !loading && !importing && busyKey === null;
  const showEmpty = !loading && !loadError && items.length === 0;

  const openImportPicker = () => {
    fileInputRef.current?.click();
  };

  const openFeedbackDialog = (tone: "success" | "error", message: string) => {
    setFeedbackDialog({ tone, message });
  };

  return (
    <div className="flex h-full flex-col gap-6 px-16 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">我的录制</h1>
          {quotaLabel ? <p className="mt-2 text-xs text-muted">{quotaLabel}</p> : null}
          <div
            role="tablist"
            aria-label="录制来源"
            className="mt-4 inline-flex rounded-md border border-border bg-surface p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "local"}
              className={tabClassName(view === "local")}
              onClick={() => setView("local")}
            >
              本地录制
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "cloud"}
              className={tabClassName(view === "cloud")}
              onClick={() => setView("cloud")}
            >
              云端录制
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="导入 zip 文件"
            onChange={(event) => void handleImportChange(event)}
          />
          {view === "local" ? (
            <button
              type="button"
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={openImportPicker}
              disabled={!canImport}
            >
              {importing ? "导入中…" : "导入 ZIP"}
            </button>
          ) : null}
          <Link
            to="/record"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            新建录制
          </Link>
        </div>
      </header>

      {loadError ? (
        <div className="flex flex-col gap-3 rounded-md border border-danger/40 bg-danger/10 p-4">
          <p className="text-sm text-danger">{loadError}</p>
          <button
            type="button"
            className="w-fit rounded-md border border-danger/50 px-3 py-1.5 text-xs font-medium text-danger"
            onClick={() => void refresh()}
          >
            重试
          </button>
        </div>
      ) : showEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-surface/60 p-12 text-center">
          <p className="font-display text-lg">{view === "cloud" ? "还没有云端录制" : "还没有录制"}</p>
          <p className="max-w-sm text-sm text-muted">
            {view === "cloud"
              ? "从本地录制列表上传后，会在这里查看和播放云端录制。"
              : "点击右上角「新建录制」开始第一段代码讲解。"}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface/60">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[9rem]" />
              <col className="w-[16rem]" />
              <col className="w-[13rem]" />
              <col className="w-[12rem]" />
              <col className="w-[8rem]" />
              <col className="w-[8rem]" />
              <col className="w-[13rem]" />
            </colgroup>
            <thead className="bg-surface-raised text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">封面</th>
                <th className="px-4 py-3 text-left font-medium">标题</th>
                <th className="px-4 py-3 text-left font-medium">创建时间</th>
                <th className="px-4 py-3 text-left font-medium">时长</th>
                <th className="px-4 py-3 text-left font-medium">语言</th>
                <th className="px-4 py-3 text-left font-medium">设备</th>
                <th className="px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr key={item.id} className="align-middle">
                  <td className="px-4 py-3">
                    <RecordingThumbnail
                      title={item.title}
                      src={thumbnailSrcForItem(view, item, localThumbnailUrls)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <EllipsisLink
                      to={replayPath(view, item.id)}
                      text={item.title}
                      className="font-medium text-foreground hover:underline"
                    />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatCreatedAt(item.createdAt)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatDurationMs(item.durationMs)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatLanguage(item.initialLanguage)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText
                      text={`${item.hasAudio ? "音频" : "无音频"} · ${item.hasCamera ? "摄像头" : "无摄像头"}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        icon={<span aria-hidden>▶</span>}
                        label="回放"
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(replayPath(view, item.id))}
                        disabled={busyKey !== null || importing}
                      />
                      {view === "cloud" ? (
                        <IconButton
                          icon={<Share2 aria-hidden size={14} />}
                          label="复制分享链接"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleShare(item as CloudRecordingListItem)}
                          disabled={busyKey !== null || importing}
                        />
                      ) : null}
                      <Popover
                        open={pendingRenameId === item.id}
                        onOpenChange={(open) => {
                          if (open) {
                            handleRenameStart(item);
                          } else {
                            handleRenameCancel();
                          }
                        }}
                        align="end"
                        side="top"
                        width={300}
                        trigger={(
                          <IconButton
                            icon={<span aria-hidden>✎</span>}
                            label="重命名"
                            variant="ghost"
                            size="sm"
                            disabled={busyKey !== null || importing}
                          />
                        )}
                      >
                        <form
                          className="space-y-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleRenameSubmit(item);
                          }}
                        >
                          <p className="text-xs text-foreground">重命名「{item.title}」</p>
                          <input
                            value={pendingRenameId === item.id ? pendingRenameValue : item.title}
                            onChange={(event) => setPendingRenameValue(event.target.value)}
                            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-focus"
                            placeholder="输入新标题"
                            aria-label={`重命名 ${item.title}`}
                            autoFocus
                          />
                          {renameError && pendingRenameId === item.id ? (
                            <p className="text-[11px] text-danger">{renameError}</p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-1 text-xs text-muted"
                              onClick={handleRenameCancel}
                              disabled={busyKey === `rename-${item.id}`}
                            >
                              取消
                            </button>
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                              disabled={busyKey === `rename-${item.id}`}
                            >
                              {busyKey === `rename-${item.id}` ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </form>
                      </Popover>
                      {view === "local" ? (
                        <>
                          <IconButton
                            icon={<span aria-hidden>⇧</span>}
                            label="上传到云端"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleUpload(item as RecordingListItem)}
                            disabled={busyKey !== null || importing}
                          />
                          <IconButton
                            icon={<span aria-hidden>⇩</span>}
                            label="导出 ZIP"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleExport(item as RecordingListItem)}
                            disabled={busyKey !== null || importing}
                          />
                        </>
                      ) : null}
                      <Popover
                        open={pendingDeleteId === item.id}
                        onOpenChange={(open) => {
                          setPendingDeleteId(open ? item.id : null);
                          if (!open) setDeleteError(null);
                        }}
                        align="end"
                        side="top"
                        width={260}
                        trigger={(
                          <IconButton
                            icon={<span aria-hidden>✕</span>}
                            label="删除"
                            variant="ghost"
                            size="sm"
                            disabled={busyKey !== null || importing}
                          />
                        )}
                      >
                        <div className="space-y-2">
                          <p className="text-xs text-foreground">确认删除「{item.title}」？</p>
                          <p className="text-[11px] text-muted">删除后不可恢复。</p>
                          {deleteError && pendingDeleteId === item.id ? (
                            <p className="text-[11px] text-danger">{deleteError}</p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-1 text-xs text-muted"
                              onClick={() => {
                                setPendingDeleteId(null);
                                setDeleteError(null);
                              }}
                              disabled={busyKey === `delete-${item.id}`}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-danger/50 bg-danger/10 px-2 py-1 text-xs text-danger"
                              onClick={() => void handleDelete(item)}
                              disabled={busyKey === `delete-${item.id}`}
                            >
                              {busyKey === `delete-${item.id}` ? "删除中…" : "确认删除"}
                            </button>
                          </div>
                        </div>
                      </Popover>
                    </div>
                    {uploadProgress?.recordingId === item.id ? (
                      <p className="mt-1 text-right text-[11px] text-muted">{uploadProgress.message}</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
          <div
            role="status"
            aria-live="polite"
            className="w-full max-w-xs rounded-md border border-border bg-popover p-4 shadow-elevation-3"
          >
            <p className="text-sm text-foreground">加载中…</p>
          </div>
        </div>
      ) : null}
      {feedbackDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-md border border-border bg-popover p-4 shadow-elevation-3"
          >
            <p
              className={[
                "text-sm",
                feedbackDialog.tone === "error" ? "text-danger" : "text-foreground",
              ].join(" ")}
            >
              {feedbackDialog.message}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground"
                onClick={() => setFeedbackDialog(null)}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type EllipsisTextProps = {
  text: string;
  align?: "left" | "center" | "right";
  className?: string;
};

function RecordingThumbnail({ title, src }: { title: string; src: string | null }) {
  const label = `${title} 封面`;
  return (
    <div className="h-16 w-28 overflow-hidden rounded-md border border-border bg-background shadow-sm">
      {src ? (
        <img src={src} alt={label} className="h-full w-full object-cover" />
      ) : (
        <div
          role="img"
          aria-label={`${label}占位`}
          className="flex h-full w-full items-center justify-center bg-surface-raised text-[10px] font-semibold uppercase tracking-widest text-muted"
        >
          CT
        </div>
      )}
    </div>
  );
}

function EllipsisText({ text, align = "left", className = "" }: EllipsisTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const checkOverflow = () => {
      setOverflowing(node.scrollWidth > node.clientWidth);
    };
    checkOverflow();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(checkOverflow) : null;
    observer?.observe(node);
    window.addEventListener("resize", checkOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", checkOverflow);
    };
  }, [text]);

  const base = (
    <span
      ref={ref}
      className={[
        "block w-full truncate",
        align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left",
        className,
      ].join(" ")}
    >
      {text}
    </span>
  );

  if (!overflowing) return base;
  return (
    <Tooltip content={text} delayMs={80}>
      <span className="block w-full">{base}</span>
    </Tooltip>
  );
}

type EllipsisLinkProps = {
  to: string;
  text: string;
  align?: "left" | "center" | "right";
  className?: string;
};

function EllipsisLink({ to, text, align = "left", className = "" }: EllipsisLinkProps) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const checkOverflow = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    setOverflowing(node.scrollWidth > node.clientWidth + 1);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    checkOverflow();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(checkOverflow) : null;
    observer?.observe(node);
    window.addEventListener("resize", checkOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", checkOverflow);
    };
  }, [checkOverflow, text]);

  const link = (
    <Link
      ref={ref}
      to={to}
      onMouseEnter={checkOverflow}
      onFocus={checkOverflow}
      className={[
        "inline-block max-w-full truncate align-middle",
        align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left",
        className,
      ].join(" ")}
    >
      {text}
    </Link>
  );

  if (!overflowing) return link;
  return (
    <Tooltip content={text} delayMs={80}>
      {link}
    </Tooltip>
  );
}

function buildImportErrorMessage(result: Extract<SaveResult, { ok: false }>): string {
  return `导入失败：${buildSaveResultError(result)}`;
}

function buildSaveResultError(result: Extract<SaveResult, { ok: false }>): string {
  if (result.reason === "validation-failed") {
    return `压缩包校验不通过（${result.message}）。`;
  }
  if (result.reason === "quota-exceeded") {
    return "本地存储空间不足，请清理旧录制后重试。";
  }
  if (result.reason === "media-write-failed") {
    return `媒体写入失败（${result.message}）。`;
  }
  return result.message;
}

function replayPath(view: "local" | "cloud", recordingId: string): string {
  return view === "cloud" ? `/replays/${recordingId}` : `/replay/${recordingId}`;
}

function thumbnailSrcForItem(
  view: "local" | "cloud",
  item: LibraryItem,
  localThumbnailUrls: Record<string, string>,
): string | null {
  if (view === "cloud") return (item as CloudRecordingListItem).thumbnailUrl;
  return localThumbnailUrls[item.id] ?? null;
}

function buildAbsoluteShareUrl(url: string): string {
  const basePath = normalizeBasePath(import.meta.env.BASE_URL ?? "/");
  const path = url.startsWith("/") ? `${basePath}${url}` : url;
  return new URL(path, window.location.origin).toString();
}

function normalizeBasePath(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized || normalized === "/") return "";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

async function writeClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("浏览器不支持剪贴板写入");
  }
  await navigator.clipboard.writeText(value);
}

function tabClassName(active: boolean): string {
  return [
    "rounded px-3 py-1.5 text-xs font-medium transition-colors",
    active ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground",
  ].join(" ");
}

function formatCloudError(error: CloudApiError): string {
  const request = error.requestId ? `，requestId: ${error.requestId}` : "";
  return `${error.message}（${error.code}${request}）`;
}

function formatPackageLoadError(error: PackageLoadError): string {
  if (error.code === "unsupported-schema") return `不支持的 schema：${error.schemaVersion}`;
  if (error.code === "invalid-manifest") return error.message;
  if (error.code === "invalid-event") {
    return error.seq === undefined ? error.message : `事件 ${error.seq} 无效：${error.message}`;
  }
  if (error.code === "checksum-mismatch") return `${error.target} checksum mismatch`;
  return `录制包不完整：${error.packageId}`;
}

function formatUploadProgress(bytesUploaded: number, totalBytes: number): string {
  if (totalBytes <= 0) return "上传中…";
  const percent = Math.min(100, Math.max(0, Math.round((bytesUploaded / totalBytes) * 100)));
  return `上传中 ${percent}%`;
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatLanguage(language: string): string {
  if (language === "javascript") return "JavaScript";
  if (language === "typescript") return "TypeScript";
  if (language === "python") return "Python";
  return language;
}
