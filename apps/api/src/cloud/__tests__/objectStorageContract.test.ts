import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectStorage } from "../objectStorage.js";

test("ObjectStorage requires playback asset URL generation", () => {
  type Assert<T extends true> = T;
  type AssetUrlIsRequired = undefined extends ObjectStorage["getAssetUrl"] ? false : true;

  const contract: Assert<AssetUrlIsRequired> = true;
  assert.equal(contract, true);
});
