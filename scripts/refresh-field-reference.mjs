#!/usr/bin/env node
/**
 * Refreshes field_reference.json with live data from QMetry.
 * Usage: QTM4J_API_KEY=<key> node scripts/refresh-field-reference.mjs
 */

const API_KEY = process.env.QTM4J_API_KEY;
const PROJECT_ID = 10011;
const BASE = "https://qtmcloud.qmetry.com/rest/api/latest";

if (!API_KEY) {
  console.error("Error: QTM4J_API_KEY environment variable is required");
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { apiKey: API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data ?? data);
}

console.log("Fetching field reference data from QMetry project", PROJECT_ID, "...");

const [
  executionResults,
  testCaseStatuses,
  testCycleStatuses,
  testPlanStatuses,
  priorities,
  environments,
  builds,
  labels,
  components,
  testCaseFolders,
  testCycleFolders,
  testPlanFolders,
] = await Promise.all([
  get(`/projects/${PROJECT_ID}/execution-results`),
  get(`/projects/${PROJECT_ID}/testcase-statuses`),
  get(`/projects/${PROJECT_ID}/testcycle-statuses`),
  get(`/projects/${PROJECT_ID}/testplan-statuses`),
  get(`/projects/${PROJECT_ID}/priorities`),
  get(`/projects/${PROJECT_ID}/environments`),
  get(`/projects/${PROJECT_ID}/builds`),
  get(`/projects/${PROJECT_ID}/labels`),
  get(`/projects/${PROJECT_ID}/components`),
  get(`/projects/${PROJECT_ID}/testcase-folders`),
  get(`/projects/${PROJECT_ID}/testcycle-folders`),
  get(`/projects/${PROJECT_ID}/testplan-folders`),
]);

// Extract only top-level folders for the reference
const topLevel = (folders) =>
  (Array.isArray(folders) ? folders : folders ?? []).map(({ id, name }) => ({ id, name }));

const reference = {
  _description: `Real values fetched from QMetry project ${PROJECT_ID} (FS). Generated on ${new Date().toISOString().split("T")[0]}.`,
  _usage: "Run 'node scripts/refresh-field-reference.mjs' to update with latest values.",

  project: { projectId: PROJECT_ID, projectKey: "FS", region: "US" },

  executionResults: {
    _usage: "Use 'id' as executionResultId in update_test_execution and bulk_update_test_executions",
    data: executionResults.map(({ id, name }) => ({ id, name })),
  },
  testCaseStatuses: {
    _usage: "Use 'name' as the status filter value in search_test_cases and create/update_test_case",
    data: testCaseStatuses.map(({ id, name }) => ({ id, name })),
  },
  testCycleStatuses: {
    _usage: "Use 'name' as the status filter value in search_test_cycles and create/update_test_cycle",
    data: testCycleStatuses.map(({ id, name }) => ({ id, name })),
  },
  testPlanStatuses: {
    _usage: "Use 'name' as the status filter value in search_test_plans and create/update_test_plan",
    data: testPlanStatuses.map(({ id, name }) => ({ id, name })),
  },
  priorities: {
    _usage: "Use 'name' as the priority filter or value in create/update/search tools",
    data: priorities.map(({ id, name }) => ({ id, name })),
  },
  environments: {
    _usage: "Use 'id' as environmentId in update_test_execution and bulk_update_test_executions",
    data: environments.map(({ id, name }) => ({ id, name })),
  },
  builds: {
    _usage: "Use 'id' as buildId in update_test_execution and bulk_update_test_executions",
    data: builds.map(({ id, name }) => ({ id, name })),
  },
  labels: {
    _usage: "Use 'name' as label filter values in search_test_cases",
    data: labels.map(({ id, name }) => ({ id, name })),
  },
  components: {
    _usage: "Use 'name' as component filter values in search_test_cases and create/update_test_case",
    data: components.map(({ id, name }) => ({ id, name })),
  },
  testCaseFolders: {
    _usage: "Use 'id' as folderId when filtering or creating test cases",
    _note: "Top-level folders only. Run list_folders with folderType=TESTCASE to get full nested tree.",
    data: topLevel(testCaseFolders),
  },
  testCycleFolders: {
    _usage: "Use 'id' as folderId when filtering or creating test cycles",
    _note: "Top-level folders only. Run list_folders with folderType=TESTCYCLE to get full nested tree.",
    data: topLevel(testCycleFolders),
  },
  testPlanFolders: {
    _usage: "Use 'id' as folderId when filtering or creating test plans",
    _note: "Top-level folders only. Run list_folders with folderType=TESTPLAN to get full nested tree.",
    data: topLevel(testPlanFolders),
  },
  keyFormats: {
    _description: "Key formats used across the API",
    testCase: "FS-TC-{number}  e.g. FS-TC-31950",
    testCycle: "FS-TR-{number}  e.g. FS-TR-747",
    testPlan: "FS-TP-{number}  e.g. FS-TP-43",
  },
  paginationParams: {
    _description: "Supported by all search/list tools",
    startAt: "integer, default 0 — page offset",
    maxResults: "integer, 1-100, default 50",
    sort: "e.g. 'id:asc', 'id:desc', 'updated:desc'",
    fields: "comma-separated field names to return e.g. 'id,key,status'",
  },
  sortExamples: ["id:asc", "id:desc", "updated:desc", "created:desc"],
};

import { writeFileSync } from "fs";
writeFileSync("field_reference.json", JSON.stringify(reference, null, 2));
console.log("✓ field_reference.json updated");
console.log(`  execution results: ${executionResults.length}`);
console.log(`  environments: ${environments.length}`);
console.log(`  builds: ${builds.length}`);
console.log(`  labels: ${labels.length}`);
console.log(`  components: ${components.length}`);
