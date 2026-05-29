import { describe, expect, it } from "vitest";
import { appRoutes } from "../routes";

describe("appRoutes", () => {
  it("registers cloud replay routes", () => {
    const childPaths = appRoutes[0]?.children?.map((route) => route.path) ?? [];

    expect(childPaths).toContain("replays/:id");
    expect(childPaths).toContain("cloud/replay/:id");
  });
});
