import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmptyDeep, componentNames, tallyByComponent } from "./executions.js";

test("stripEmptyDeep removes nulls, empty objects and empty arrays", () => {
  const input = {
    key: "FS-TC-1",
    priority: {},
    status: {},
    description: null,
    labels: [],
    components: [{ id: 1, name: "IAM", description: null }],
    nested: { a: {}, b: "keep" },
  };
  assert.deepEqual(stripEmptyDeep(input), {
    key: "FS-TC-1",
    components: [{ id: 1, name: "IAM" }],
    nested: { b: "keep" },
  });
});

test("stripEmptyDeep preserves scalars, false and 0", () => {
  assert.deepEqual(stripEmptyDeep({ archived: false, versionNo: 0, ok: true }), {
    archived: false,
    versionNo: 0,
    ok: true,
  });
});

test("stripEmptyDeep maps over arrays", () => {
  assert.deepEqual(stripEmptyDeep([{ a: null, b: 1 }]), [{ b: 1 }]);
});

test("componentNames handles object form, string form, and absence", () => {
  assert.deepEqual(componentNames({ components: [{ id: 1, name: "IAM" }, { name: "CLB" }] }), ["IAM", "CLB"]);
  assert.deepEqual(componentNames({ components: ["CBS"] }), ["CBS"]);
  assert.deepEqual(componentNames({ components: [] }), []);
  assert.deepEqual(componentNames({}), []);
  assert.deepEqual(componentNames(null), []);
});

test("tallyByComponent counts per component, multi-component and none", () => {
  const items = [
    { components: [{ name: "IAM" }] },
    { components: [{ name: "IAM" }, { name: "CLB" }] },
    { components: [] },
    {},
  ];
  assert.deepEqual(tallyByComponent(items), { IAM: 2, "(none)": 2, CLB: 1 });
});

test("tallyByComponent sorts by count desc then name", () => {
  const items = [
    { components: [{ name: "B" }] },
    { components: [{ name: "A" }] },
    { components: [{ name: "C" }] },
    { components: [{ name: "C" }] },
  ];
  assert.deepEqual(Object.keys(tallyByComponent(items)), ["C", "A", "B"]);
});
