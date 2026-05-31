import { expect, test, type Page } from "@playwright/test";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

test("primary slash comments the current editor line", async ({ page }) => {
  await openRecorder(page);

  await page.keyboard.type("const commented = true;");
  await page.keyboard.press(`${PRIMARY_MODIFIER}+/`);

  await expect(editorLines(page)).toContainText(/\/\/[\s\u00a0]*const[\s\u00a0]+commented[\s\u00a0]*=[\s\u00a0]*true;/);
});

test("shift alt f formats the current editor document", async ({ page }) => {
  await openRecorder(page);

  await page.keyboard.type("function demo(){\n\t\treturn 1;");
  await page.keyboard.press("Shift+Alt+F");

  await expect(editorLines(page)).toContainText("function demo() {");
  await expect(editorLines(page)).toContainText("return 1;");
  await expect(editorLines(page)).toContainText("}");
});

test("primary g opens Monaco go to line", async ({ page }) => {
  await openRecorder(page);

  await page.keyboard.type("const first = 1;\nconst second = 2;");
  await page.keyboard.press(`${PRIMARY_MODIFIER}+G`);

  await expect(page.locator(".quick-input-widget")).toBeVisible();
});

async function openRecorder(page: Page): Promise<void> {
  await page.goto("/record", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-code-editor] .monaco-editor")).toBeVisible();
  await page.locator("[data-code-editor] .monaco-editor").click();
}

function editorLines(page: Page) {
  return page.locator("[data-code-editor] .view-lines");
}
