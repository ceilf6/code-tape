import { expect, test, type Page } from "@playwright/test";

const LONG_MICROPHONE_LABEL =
  "Very long studio microphone device name used to verify responsive wrapping without horizontal overflow";
const LONG_CAMERA_LABEL =
  "Very long external camera device name used to verify responsive wrapping without horizontal overflow";

test("recorder route renders Monaco with usable recorder controls", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "我的录制" })).toBeVisible();

  await page.getByRole("link", { name: "新建录制" }).click();
  await expect(page.locator("[data-code-editor] .monaco-editor")).toBeVisible();
  await expect(page.getByText(/CodeEditor scaffold/)).toHaveCount(0);
  await expect(page.getByText("待录制")).toBeVisible();
  await expect(page.getByText("00:00")).toBeVisible();
  await expect(page.getByText(/RecorderControls scaffold/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始录制" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "暂停录制" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "继续录制" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "停止录制" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "运行代码" })).toBeEnabled();

  await page.getByRole("button", { name: /Dark|Light/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
  expect(runtimeErrors.filter((message) => /monaco|worker/i.test(message))).toEqual([]);
});

test("recorder route keeps controls and workspace usable at narrow desktop widths", async ({ page }) => {
  await installLongMediaDevices(page);
  await page.setViewportSize({ width: 768, height: 720 });
  await page.goto("/record", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-code-editor] .monaco-editor")).toBeVisible();
  await selectLongDeviceNames(page);

  await expect(page.getByRole("button", { name: "开始录制" })).toBeVisible();
  await expect(page.getByRole("button", { name: "暂停录制" })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续录制" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止录制" })).toBeVisible();
  await expect(page.getByRole("button", { name: "运行代码" })).toBeVisible();
  await expect(page.getByLabel("麦克风设备")).toBeVisible();
  await expect(page.getByLabel("摄像头设备")).toBeVisible();
  await expectRecorderShellToFit(page);

  const workspaceLayout = await page.locator("[data-recorder-host]").evaluate((host) => {
    const editor = host.querySelector("[data-code-editor]");
    const output = host.querySelector("[aria-label='录制预览与输出区']");
    if (!(editor instanceof HTMLElement) || !(output instanceof HTMLElement)) {
      return null;
    }
    const editorBox = editor.getBoundingClientRect();
    const outputBox = output.getBoundingClientRect();
    return {
      editorBottom: Math.round(editorBox.bottom),
      outputTop: Math.round(outputBox.top),
      outputLeft: Math.round(outputBox.left),
      outputWidth: Math.round(outputBox.width),
      outputHeight: Math.round(outputBox.height),
    };
  });
  expect(workspaceLayout).not.toBeNull();
  expect(workspaceLayout!.outputTop).toBeGreaterThan(workspaceLayout!.editorBottom - 2);
  expect(workspaceLayout!.outputLeft).toBe(0);
  expect(workspaceLayout!.outputWidth).toBeGreaterThanOrEqual(720);
  expect(workspaceLayout!.outputHeight).toBeGreaterThanOrEqual(200);

  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/record", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-code-editor] .monaco-editor")).toBeVisible();
    await selectLongDeviceNames(page);
    await expect(page.getByRole("button", { name: "申请设备权限" })).toBeVisible();
    await expectRecorderShellToFit(page);
  }
});

test("missing replay id shows an explicit load error", async ({ page }) => {
  await page.goto("/replay/missing-recording", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/加载失败/)).toBeVisible();
  await expect(page.getByText(/incomplete-package/)).toBeVisible();
});

async function installLongMediaDevices(page: Page) {
  await page.addInitScript(
    ([microphoneLabel, cameraLabel]) => {
      const devices = [
        {
          deviceId: "mic-long",
          groupId: "group-audio",
          kind: "audioinput",
          label: microphoneLabel,
          toJSON: () => ({}),
        },
        {
          deviceId: "camera-long",
          groupId: "group-video",
          kind: "videoinput",
          label: cameraLabel,
          toJSON: () => ({}),
        },
      ];
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          enumerateDevices: async () => devices,
          getUserMedia: async () => {
            const error = new Error("Media capture is not needed for this layout regression");
            error.name = "NotAllowedError";
            throw error;
          },
        },
      });
    },
    [LONG_MICROPHONE_LABEL, LONG_CAMERA_LABEL],
  );
}

async function selectLongDeviceNames(page: Page) {
  const microphone = page.getByLabel("麦克风设备");
  const camera = page.getByLabel("摄像头设备");
  await expect(microphone).toContainText(LONG_MICROPHONE_LABEL);
  await expect(camera).toContainText(LONG_CAMERA_LABEL);
  await microphone.selectOption("mic-long");
  await camera.selectOption("camera-long");
}

async function expectRecorderShellToFit(page: Page) {
  const overflowing = await page.locator("[data-recorder-host]").evaluate((host) => {
    const checks = [
      { name: "document", element: document.documentElement },
      { name: "body", element: document.body },
      { name: "host", element: host },
      { name: "controls", element: host.querySelector("[role='toolbar']") },
      { name: "setup", element: host.querySelector("[data-recorder-setup]") },
      { name: "workspace", element: host.querySelector("[aria-label='录制工作区']") },
    ];
    return checks.flatMap(({ name, element }) => {
      if (!(element instanceof HTMLElement)) return [`${name}:missing`];
      const overflow = element.scrollWidth - element.clientWidth;
      return overflow > 1 ? [`${name}:${element.scrollWidth}>${element.clientWidth}`] : [];
    });
  });
  expect(overflowing).toEqual([]);
}
