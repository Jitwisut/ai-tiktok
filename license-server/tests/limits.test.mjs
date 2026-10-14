import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidLicenseDays, LIFETIME_DAYS, MAX_LICENSE_DAYS } from "../src/lib/licensing/limits.ts";

test("license day limits accept presets up to lifetime and reject the rest", () => {
  for (const days of [1, 7, 30, 3650, 3651, LIFETIME_DAYS]) assert.equal(isValidLicenseDays(days), true, String(days));
  for (const days of [0, -1, 1.5, MAX_LICENSE_DAYS + 1, 999999, Number.NaN, "30", null]) assert.equal(isValidLicenseDays(days), false, String(days));
});
