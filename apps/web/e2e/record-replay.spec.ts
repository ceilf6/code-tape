import { expect, test, type Page } from "@playwright/test";

type StoredRecording = {
  meta: {
    durationMs: number;
  };
  events: Array<{
    type: string;
    timestampMs: number;
    payload: Record<string, unknown>;
  }>;
};

const DB_NAME = "code-tape";
const FIRST_OUTPUT = "run:seek-before";
const LONG_INPUT = "abcdefghijklmnopqrstuvwxyz1234";
const FINAL_OUTPUT = `run:seek-after:${LONG_INPUT.length}`;

test("records, saves, replays, seeks, and keeps content-change events debounced", async ({
  page,
}) => {
  const runtimeErrors = collectRuntimeErrors(page);

  await page.goto("/record", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-code-editor] .monaco-editor")).toBeVisible();

  await page.getByLabel("麦克风设备").selectOption("");
  await page.getByLabel("摄像头设备").selectOption("");

  await page.getByRole("button", { name: "开始录制" }).click();
  await expect(page.getByLabel("录制状态：录制中")).toBeVisible();

  await typeInEditor(
    page,
    `document.body.textContent = "seek-before";\nconsole.log("${FIRST_OUTPUT}");\n`,
  );
  await moveAndClickInsideEditor(page);
  await selectRecentEditorText(page);
  await pressRecordedShortcut(page, "Control+/");
  await page.waitForTimeout(550);
  await pressRecordedShortcut(page, "Control+/");
  await page.waitForTimeout(550);
  await pressRecordedShortcut(page, "Shift+Alt+F");
  await pressRecordedShortcut(page, "Control+G");
  await page.keyboard.press("Escape");
  await runCodeWithShortcutAndWaitForPreview(page, "seek-before");

  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "暂停录制" }).click();
  await expect(page.getByLabel("录制状态：已暂停")).toBeVisible();
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "继续录制" }).click();
  await expect(page.getByLabel("录制状态：录制中")).toBeVisible();

  await typeInEditor(
    page,
    `const typed = "${LONG_INPUT}";\ndocument.body.textContent = "seek-after:" + typed.length;\nconsole.log("run:seek-after:" + typed.length);\n`,
  );
  await runCodeAndWaitForPreview(page, `seek-after:${LONG_INPUT.length}`);
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "停止录制" }).click();
  await expect(page).toHaveURL(/\/replay\/[^/]+$/);
  await expect(page.getByRole("button", { name: "播放" })).toBeEnabled();

  const recordingId = recordingIdFromUrl(page.url());
  const stored = await readStoredRecording(page, recordingId);
  expect(stored).not.toBeNull();

  const recording = stored!;
  const contentChanges = recording.events.filter((event) => event.type === "content-change");
  const runOutputs = recording.events.filter((event) => event.type === "run-output");
  const shortcutEvents = recording.events.filter((event) => event.type === "shortcut");
  const shortcutCommands = shortcutEvents.map((event) => event.payload.command);
  const firstRunOutput = runOutputs.find((event) =>
    Array.isArray(event.payload.stdout)
    && event.payload.stdout.includes(FIRST_OUTPUT),
  );
  const finalRunOutput = runOutputs.find((event) =>
    Array.isArray(event.payload.stdout)
    && event.payload.stdout.includes(FINAL_OUTPUT),
  );

  expect(recording.events.some((event) => event.type === "record-pause")).toBe(true);
  expect(recording.events.some((event) => event.type === "record-resume")).toBe(true);
  expect(recording.events.some((event) => event.type === "record-stop")).toBe(true);
  expect(recording.events.some((event) => event.type === "mouse-move")).toBe(true);
  expect(recording.events.some((event) => event.type === "mouse-click")).toBe(true);
  expect(
    recording.events.some((event) => event.type === "selection-change" && event.payload.selection),
  ).toBe(true);
  expect(shortcutCommands).toEqual(expect.arrayContaining(["comment", "format", "go-to-line", "run"]));
  expect(contentChanges.length).toBeGreaterThan(0);
  expect(contentChanges.length).toBeLessThan(30);
  expect(contentChanges.at(-1)?.payload.code).toContain(LONG_INPUT);
  expect(firstRunOutput).toBeTruthy();
  expect(finalRunOutput).toBeTruthy();
  const runShortcut = shortcutEvents.find((event) => event.payload.command === "run");
  const clickEvent = recording.events.find((event) => event.type === "mouse-click");
  expect(runShortcut).toBeTruthy();
  expect(clickEvent).toBeTruthy();

  await page.getByRole("button", { name: "播放" }).click();
  await expect(page.getByRole("button", { name: "暂停" })).toBeEnabled();
  await page.getByRole("button", { name: "暂停" }).click();
  await expect(page.getByRole("button", { name: "播放" })).toBeEnabled();
  await page.getByRole("button", { name: "静音" }).click();
  await expect(page.getByRole("button", { name: "取消静音" })).toBeVisible();
  await page.locator("[data-replay-volume-control]").hover();
  await page.waitForTimeout(250);
  await expect(page.getByRole("slider", { name: "音量" })).toBeVisible();

  await page.getByRole("button", { name: "倍速" }).click();
  await page.getByRole("option", { name: "2x" }).click();
  await expect(page.getByRole("option", { name: "2x" })).toHaveAttribute("aria-selected", "true");

  const runtimeOutput = page.getByRole("region", { name: "Runtime output" });
  await seekByProgress(page, clickEvent!.timestampMs + 20, recording.meta.durationMs);
  await expect(page.getByLabel("回放鼠标位置")).toBeVisible();
  await seekByProgress(page, runShortcut!.timestampMs + 20, recording.meta.durationMs);
  await expect(page.getByLabel("回放快捷键")).toContainText("Run");
  await seekByProgress(page, firstRunOutput!.timestampMs + 20, recording.meta.durationMs);
  await expect(page.locator("[data-code-editor]")).toContainText("seek-before");
  await expect(page.locator("[data-code-editor]")).not.toContainText(LONG_INPUT);
  await expect(runtimeOutput.getByText(FIRST_OUTPUT, { exact: true })).toBeVisible();
  await expect(runtimeOutput.getByText(FINAL_OUTPUT, { exact: true })).toHaveCount(0);

  await seekByProgress(page, finalRunOutput!.timestampMs + 20, recording.meta.durationMs);
  await expect(page.locator("[data-code-editor]")).toContainText(LONG_INPUT);
  await expect(runtimeOutput.getByText(FINAL_OUTPUT, { exact: true })).toBeVisible();

  expect(runtimeErrors.filter((message) => /monaco|worker|indexeddb/i.test(message))).toEqual([]);
});

function collectRuntimeErrors(page: Page): string[] {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  return runtimeErrors;
}

async function typeInEditor(page: Page, source: string): Promise<void> {
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.type(source, { delay: 2 });
  await expect(page.locator("[data-code-editor]")).toContainText(source.split("\n")[0] ?? source);
}

async function moveAndClickInsideEditor(page: Page): Promise<void> {
  const editor = page.locator("[data-code-editor]").first();
  const box = await editor.boundingBox();
  if (!box) throw new Error("Code editor surface is not visible");
  const x = box.x + Math.min(120, box.width / 2);
  const y = box.y + Math.min(120, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
}

async function selectRecentEditorText(page: Page): Promise<void> {
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
}

async function pressRecordedShortcut(page: Page, shortcut: string): Promise<void> {
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.press(shortcut);
}

async function runCodeAndWaitForPreview(page: Page, expectedText: string): Promise<void> {
  await page.getByRole("button", { name: "运行代码" }).click();
  await expect(
    page.frameLocator('iframe[title="code-tape preview"]').locator("body"),
  ).toContainText(expectedText);
}

async function runCodeWithShortcutAndWaitForPreview(page: Page, expectedText: string): Promise<void> {
  await pressRecordedShortcut(page, "Control+Enter");
  await expect(
    page.frameLocator('iframe[title="code-tape preview"]').locator("body"),
  ).toContainText(expectedText);
}

function recordingIdFromUrl(url: string): string {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/replay\/([^/]+)$/);
  if (!match) throw new Error(`Could not read replay id from ${url}`);
  return decodeURIComponent(match[1]);
}

async function readStoredRecording(page: Page, recordingId: string): Promise<StoredRecording | null> {
  return page.evaluate(
    async ({ databaseName, id }) => {
      const openRequest = indexedDB.open(databaseName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        openRequest.onupgradeneeded = () => {
          openRequest.transaction?.abort();
          reject(new Error(`IndexedDB ${databaseName} unexpectedly required an upgrade`));
        };
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => resolve(openRequest.result);
      });
      try {
        const tx = db.transaction("recordings", "readonly");
        const request = tx.objectStore("recordings").get(id);
        const stored = await new Promise<StoredRecording | null>((resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve((request.result as StoredRecording | undefined) ?? null);
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
          tx.onerror = () => reject(tx.error ?? new Error("transaction errored"));
        });
        return stored;
      } finally {
        db.close();
      }
    },
    { databaseName: DB_NAME, id: recordingId },
  );
}

async function seekByProgress(page: Page, targetMs: number, durationMs: number): Promise<void> {
  const percent = durationMs > 0 ? Math.max(0, Math.min(targetMs / durationMs, 1)) : 0;
  const targetPercent = Math.round(percent * 1000) / 10;
  const progressControl = page.locator("[data-replay-progress-control]");
  const sliderRoot = progressControl.locator('[aria-label="播放进度"]').first();
  const sliderThumb = progressControl.getByRole("slider", { name: "播放进度" });

  await expect(sliderThumb).toBeEnabled();
  const rootBox = await sliderRoot.boundingBox();
  const thumbBox = await sliderThumb.boundingBox();
  if (!rootBox || !thumbBox) throw new Error("Replay progress slider is not visible");

  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rootBox.x + rootBox.width * percent, rootBox.y + rootBox.height / 2, {
    steps: 4,
  });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const value = Number(await sliderThumb.getAttribute("aria-valuenow"));
      return Math.round(value * 10) / 10;
    })
    .toBe(targetPercent);
  await expect(sliderThumb).toBeEnabled();
}
