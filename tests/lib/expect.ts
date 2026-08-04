// Lookups that must succeed for a test to mean anything. Failing here names the missing
// value instead of letting a TypeError surface three lines later.

import assert from "node:assert/strict";

export function required<T>(value: T | null | undefined, description: string): T {
  assert.ok(value !== null && value !== undefined, `expected ${description}`);
  return value;
}
