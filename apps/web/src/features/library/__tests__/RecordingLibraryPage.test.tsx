import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingListItem, RecordingPackageV1, RecordingRepository } from "@/shared/recording-schema";
import type {
  CloudRecordingDetailResponse,
  CloudRecordingListItem,
  CloudRecordingRepository,
} from "@/features/cloud/types";

const repositoryMocks = {
  saveDraft: vi.fn(),
  commit: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  exportZip: vi.fn(),
  importZip: vi.fn(),
  loadThumbnail: vi.fn(),
  sweep: vi.fn(),
  estimateQuota: vi.fn(),
};

const cloudRepositoryMocks = {
  createUploadSession: vi.fn(),
  uploadAsset: vi.fn(),
  completeUpload: vi.fn(),
  uploadPackage: vi.fn(),
  get: vi.fn(),
  pollUntilReady: vi.fn(),
  list: vi.fn(),
  getPlaybackDescriptor: vi.fn(),
  getSharedPlaybackDescriptor: vi.fn(),
  createShareLink: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  getOwnerToken: vi.fn(),
};

vi.mock("../recordingStore", () => ({
  createRecordingStore: () => repositoryMocks as unknown as RecordingRepository,
}));

vi.mock("@/features/cloud/cloudRecordingRepository", () => ({
  createCloudRecordingRepository: () => cloudRepositoryMocks as unknown as CloudRecordingRepository,
}));

import { RecordingLibraryPage } from "../RecordingLibraryPage";

const BASE_TITLE = "Two Sum \u8bb2\u89e3";
const BASE_ITEM: RecordingListItem = {
  id: "rec-1",
  title: BASE_TITLE,
  createdAt: "2026-05-24T08:00:00.000Z",
  durationMs: 12_000,
  ownerId: null,
  creatorInfo: null,
  initialLanguage: "typescript",
  hasAudio: true,
  hasCamera: false,
  thumbnailBlobId: null,
};

const CLOUD_ITEM: CloudRecordingListItem = {
  id: "cloud-1",
  title: "Cloud Two Sum",
  createdAt: "2026-05-25T09:30:00.000Z",
  durationMs: 23_000,
  initialLanguage: "javascript",
  hasAudio: false,
  hasCamera: true,
  thumbnailUrl: null,
  visibility: "private",
};

const LOCAL_PACKAGE = {
  manifest: { packageId: "pkg-1" },
  meta: { title: BASE_TITLE },
  media: { blobId: "media-1" },
} as unknown as RecordingPackageV1;

function renderPage() {
  render(
    <MemoryRouter>
      <RecordingLibraryPage />
    </MemoryRouter>,
  );
}

describe("RecordingLibraryPage", () => {
  beforeEach(() => {
    Object.values(repositoryMocks).forEach((fn) => fn.mockReset());
    Object.values(cloudRepositoryMocks).forEach((fn) => fn.mockReset());
    repositoryMocks.list.mockResolvedValue([]);
    repositoryMocks.sweep.mockResolvedValue({ removedDrafts: 0, removedBlobs: 0 });
    repositoryMocks.estimateQuota.mockResolvedValue({ usageBytes: 0, quotaBytes: 0 });
    repositoryMocks.rename.mockResolvedValue(undefined);
    repositoryMocks.remove.mockResolvedValue(undefined);
    repositoryMocks.exportZip.mockResolvedValue(new Blob(["zip"], { type: "application/zip" }));
    repositoryMocks.importZip.mockResolvedValue({ ok: true, recordingId: "rec-new" });
    repositoryMocks.loadThumbnail.mockResolvedValue(null);
    repositoryMocks.load.mockResolvedValue({
      ok: true,
      package: LOCAL_PACKAGE,
      mediaBlob: new Blob(["media"], { type: "video/webm" }),
      warnings: [],
    });
    cloudRepositoryMocks.uploadPackage.mockResolvedValue({
      ok: true,
      value: { recordingId: "cloud-1", status: "processing" },
    });
    cloudRepositoryMocks.pollUntilReady.mockResolvedValue({
      ok: true,
      value: makeCloudDetailResponse({ status: "ready" }),
    });
    cloudRepositoryMocks.list.mockResolvedValue({
      ok: true,
      value: { items: [], nextCursor: null },
    });
    cloudRepositoryMocks.createShareLink.mockResolvedValue({
      ok: true,
      value: { url: "/s/share-token?t=4200", expiresAt: null },
    });
    cloudRepositoryMocks.rename.mockResolvedValue({ ok: true, value: undefined });
    cloudRepositoryMocks.remove.mockResolvedValue({ ok: true, value: undefined });

    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:mock"),
      });
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        writable: true,
        value: vi.fn(),
      });
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading dialog first, then empty state", async () => {
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("\u52a0\u8f7d\u4e2d");
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    expect(await screen.findByText("\u8fd8\u6ca1\u6709\u5f55\u5236")).toBeInTheDocument();
  });

  it("does not repeat the product wordmark above the library title", async () => {
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    expect(screen.getByRole("heading", { name: "\u6211\u7684\u5f55\u5236" })).toBeInTheDocument();
    expect(screen.queryByText("code-tape")).not.toBeInTheDocument();
    expect(screen.queryByText("CODE-TAPE")).not.toBeInTheDocument();
  });

  it("keeps persistent load error state after closing load-failed dialog", async () => {
    repositoryMocks.list.mockRejectedValueOnce(new Error("idb read failed"));
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("\u52a0\u8f7d\u4e2d");
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "\u91cd\u8bd5" })).toBeInTheDocument();
    expect(screen.queryByText("\u8fd8\u6ca1\u6709\u5f55\u5236")).not.toBeInTheDocument();
  });

  it("renders recording row and replay link", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const replayLink = screen.getByRole("link", { name: BASE_TITLE });
    expect(replayLink).toHaveAttribute(
      "href",
      expect.stringContaining("/replay/rec-1"),
    );
    expect(replayLink.closest("tr")).toHaveClass("align-middle");
    expect(screen.getByText(/TypeScript/)).toBeInTheDocument();
    expect(screen.getByText(/\u97f3\u9891/)).toBeInTheDocument();
    expect(screen.getByText(/\u65e0\u6444\u50cf\u5934/)).toBeInTheDocument();
  });

  it("renders a local recording thumbnail when a thumbnail blob is available", async () => {
    repositoryMocks.list.mockResolvedValue([{ ...BASE_ITEM, thumbnailBlobId: "thumbnail-1" }]);
    repositoryMocks.loadThumbnail.mockResolvedValueOnce(new Blob(["thumbnail"], { type: "image/webp" }));
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const image = await screen.findByRole("img", { name: `${BASE_TITLE} \u5c01\u9762` });

    expect(repositoryMocks.loadThumbnail).toHaveBeenCalledWith("thumbnail-1");
    expect(image).toHaveAttribute("src", "blob:mock");
  });

  it("renames a recording and refreshes list", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u547d\u540d" }));
    fireEvent.change(screen.getByLabelText(`\u91cd\u547d\u540d ${BASE_TITLE}`), {
      target: { value: "Two Sum \u8fdb\u9636" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58" }));

    await waitFor(() => {
      expect(repositoryMocks.rename).toHaveBeenCalledWith("rec-1", "Two Sum \u8fdb\u9636");
    });
    expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
  });

  it("rejects blank rename title without calling repository", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u547d\u540d" }));
    fireEvent.change(screen.getByLabelText(`\u91cd\u547d\u540d ${BASE_TITLE}`), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58" }));

    expect(await screen.findByText("\u6807\u9898\u4e0d\u80fd\u4e3a\u7a7a\u3002")).toBeInTheDocument();
    expect(repositoryMocks.rename).not.toHaveBeenCalled();
  });

  it("deletes a recording only after confirm", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5220\u9664" }));
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u5220\u9664" }));

    await waitFor(() => {
      expect(repositoryMocks.remove).toHaveBeenCalledWith("rec-1");
      expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps delete confirmation open when delete fails", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    repositoryMocks.remove.mockRejectedValueOnce(new Error("idb delete failed"));
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5220\u9664" }));
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u5220\u9664" }));

    expect(await screen.findByText("\u5220\u9664\u5931\u8d25\uff1aidb delete failed")).toBeInTheDocument();
    expect(screen.getByText(`\u786e\u8ba4\u5220\u9664\u300c${BASE_TITLE}\u300d\uff1f`)).toBeInTheDocument();
    expect(repositoryMocks.list).toHaveBeenCalledTimes(1);
  });

  it("exports a recording to zip", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    await waitFor(() => {
      expect(repositoryMocks.exportZip).toHaveBeenCalledWith("rec-1");
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  it("disables zip import while an item operation is busy", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let finishExport: (blob: Blob) => void = () => {};
    repositoryMocks.exportZip.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          finishExport = resolve;
        }),
    );
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "\u5bfc\u5165 ZIP" })).toBeDisabled();
    });

    finishExport(new Blob(["zip"], { type: "application/zip" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "\u5bfc\u5165 ZIP" })).not.toBeDisabled();
    });
  });

  it("shows export failure dialog", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    repositoryMocks.exportZip.mockRejectedValueOnce(new Error("zip failed"));
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("\u5bfc\u51fa\u5931\u8d25\uff1azip failed");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("imports valid zip and refreshes list", async () => {
    repositoryMocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...BASE_ITEM, id: "rec-new", title: "\u5bfc\u5165\u6210\u529f\u6837\u4f8b" }]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["zip"], "valid.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    await waitFor(() => {
      expect(repositoryMocks.importZip).toHaveBeenCalledTimes(1);
      expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("\u5bfc\u5165\u6210\u529f\u6837\u4f8b")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("\u5bfc\u5165\u6210\u529f\uff1avalid.zip");
  });

  it("shows clear error dialog for invalid zip import", async () => {
    repositoryMocks.importZip.mockResolvedValueOnce({
      ok: false,
      reason: "validation-failed",
      message: "checksum-mismatch:events",
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["bad"], "invalid.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "\u5bfc\u5165\u5931\u8d25\uff1a\u538b\u7f29\u5305\u6821\u9a8c\u4e0d\u901a\u8fc7",
    );
  });

  it("shows quota guidance when zip import exceeds local storage", async () => {
    repositoryMocks.importZip.mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "quota exceeded",
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["zip"], "large.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "\u672c\u5730\u5b58\u50a8\u7a7a\u95f4\u4e0d\u8db3",
    );
    expect(repositoryMocks.list).toHaveBeenCalledTimes(1);
  });

  it("recovers list after load failure retry", async () => {
    repositoryMocks.list.mockRejectedValueOnce(new Error("idb read failed")).mockResolvedValueOnce([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(await screen.findByRole("button", { name: "\u786e\u8ba4" }));
    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u8bd5" }));

    expect(await screen.findByRole("link", { name: BASE_TITLE })).toBeInTheDocument();
    expect(screen.queryByText("\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed")).not.toBeInTheDocument();
    expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
  });

  it("uploads a local recording to the cloud and refreshes cloud state", async () => {
    const mediaBlob = new Blob(["media"], { type: "video/webm" });
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    repositoryMocks.load.mockResolvedValueOnce({
      ok: true,
      package: LOCAL_PACKAGE,
      mediaBlob,
      warnings: [],
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "上传到云端" }));

    await waitFor(() => {
      expect(repositoryMocks.load).toHaveBeenCalledWith("rec-1");
      expect(cloudRepositoryMocks.uploadPackage).toHaveBeenCalledWith(
        LOCAL_PACKAGE,
        { media: mediaBlob },
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(cloudRepositoryMocks.pollUntilReady).toHaveBeenCalledWith(
        "cloud-1",
        expect.objectContaining({ intervalMs: expect.any(Number), timeoutMs: expect.any(Number) }),
      );
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("已上传");
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
  });

  it("uploads a local thumbnail to the cloud when one is available", async () => {
    const mediaBlob = new Blob(["media"], { type: "video/webm" });
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/webp" });
    repositoryMocks.list.mockResolvedValue([{ ...BASE_ITEM, thumbnailBlobId: "thumbnail-1" }]);
    repositoryMocks.loadThumbnail.mockResolvedValue(thumbnailBlob);
    repositoryMocks.load.mockResolvedValueOnce({
      ok: true,
      package: LOCAL_PACKAGE,
      mediaBlob,
      warnings: [],
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "上传到云端" }));

    await waitFor(() => {
      expect(repositoryMocks.loadThumbnail).toHaveBeenCalledWith("thumbnail-1");
      expect(cloudRepositoryMocks.uploadPackage).toHaveBeenCalledWith(
        LOCAL_PACKAGE,
        { media: mediaBlob, thumbnail: thumbnailBlob },
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
    });
  });

  it("keeps the local recording when cloud upload fails", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    cloudRepositoryMocks.uploadPackage.mockResolvedValueOnce({
      ok: false,
      error: { code: "network-error", message: "cloud offline" },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "上传到云端" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("cloud offline");
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: BASE_TITLE })).toBeInTheDocument();
  });

  it("keeps the local recording when cloud polling fails", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    cloudRepositoryMocks.pollUntilReady.mockResolvedValueOnce({
      ok: false,
      error: { code: "network-error", message: "validation timeout", requestId: "req-1" },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "上传到云端" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "上传失败：validation timeout（network-error，requestId: req-1）",
    );
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: BASE_TITLE })).toBeInTheDocument();
  });

  it("keeps the local recording when cloud validation fails", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    cloudRepositoryMocks.pollUntilReady.mockResolvedValueOnce({
      ok: true,
      value: makeCloudDetailResponse({
        status: "failed",
        failureCode: "checksum-mismatch",
        failureMessage: "events checksum mismatch",
      }),
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "上传到云端" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("上传失败：events checksum mismatch");
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: BASE_TITLE })).toBeInTheDocument();
  });

  it("renders cloud recordings and links them to the cloud replay route", async () => {
    cloudRepositoryMocks.list.mockResolvedValueOnce({
      ok: true,
      value: { items: [CLOUD_ITEM], nextCursor: null },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("tab", { name: "云端录制" }));

    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    expect(cloudRepositoryMocks.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Cloud Two Sum" })).toHaveAttribute(
      "href",
      expect.stringContaining("/replays/cloud-1"),
    );
    expect(screen.getByText(/JavaScript/)).toBeInTheDocument();
    expect(screen.getByText(/\u65e0\u97f3\u9891/)).toBeInTheDocument();
    expect(screen.getByText(/\u6444\u50cf\u5934/)).toBeInTheDocument();
  });

  it("renders a cloud recording thumbnail URL when present", async () => {
    cloudRepositoryMocks.list.mockResolvedValue({
      ok: true,
      value: {
        items: [{ ...CLOUD_ITEM, thumbnailUrl: "https://cdn.example.test/thumb.webp" }],
        nextCursor: null,
      },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("tab", { name: "云端录制" }));
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    expect(screen.getByRole("img", { name: "Cloud Two Sum \u5c01\u9762" })).toHaveAttribute(
      "src",
      "https://cdn.example.test/thumb.webp",
    );
  });

  it("copies a cloud recording share link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    cloudRepositoryMocks.list.mockResolvedValue({
      ok: true,
      value: { items: [CLOUD_ITEM], nextCursor: null },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("tab", { name: "云端录制" }));
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    fireEvent.click(screen.getByRole("button", { name: "复制分享链接" }));

    await waitFor(() => {
      expect(cloudRepositoryMocks.createShareLink).toHaveBeenCalledWith("cloud-1", {});
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/s/share-token?t=4200"));
    expect(await screen.findByRole("dialog")).toHaveTextContent("分享链接已复制");
  });

  it("renames and deletes cloud recordings through the cloud repository", async () => {
    cloudRepositoryMocks.list.mockResolvedValue({
      ok: true,
      value: { items: [CLOUD_ITEM], nextCursor: null },
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("tab", { name: "云端录制" }));
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u547d\u540d" }));
    fireEvent.change(screen.getByLabelText("重命名 Cloud Two Sum"), {
      target: { value: "Cloud Two Sum Pro" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58" }));

    await waitFor(() => {
      expect(cloudRepositoryMocks.rename).toHaveBeenCalledWith("cloud-1", "Cloud Two Sum Pro");
    });

    fireEvent.click(screen.getByRole("button", { name: "\u5220\u9664" }));
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u5220\u9664" }));

    await waitFor(() => {
      expect(cloudRepositoryMocks.remove).toHaveBeenCalledWith("cloud-1");
    });
  });
});

function makeCloudDetailResponse(
  overrides: Partial<CloudRecordingDetailResponse["recording"]> = {},
): CloudRecordingDetailResponse {
  return {
    recording: {
      id: "cloud-1",
      title: "Cloud Two Sum",
      durationMs: 23_000,
      createdAt: "2026-05-25T09:30:00.000Z",
      updatedAt: "2026-05-25T09:30:00.000Z",
      initialLanguage: "javascript",
      hasAudio: false,
      hasCamera: true,
      status: "ready",
      localPackageId: "pkg-1",
      schemaVersion: "0.1.0",
      visibility: "private",
      completedAt: "2026-05-25T09:31:00.000Z",
      totalSizeBytes: 1200,
      eventCount: 2,
      snapshotCount: 1,
      failureCode: null,
      failureMessage: null,
      ...overrides,
    },
    assets: [],
  };
}
