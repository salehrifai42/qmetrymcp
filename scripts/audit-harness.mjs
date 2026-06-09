// Live MCP audit harness: drives the real server over stdio against project 10011.
// Creates throwaway fixtures, exercises every tool, records pass/fail, cleans up.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const API_KEY = (cfg.connection.apiKey ?? "").trim();
const REGION = cfg.connection.region ?? "US";
const PROJECT = cfg.project.projectId; // 10011

const child = spawn("node", ["dist/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, QTM4J_API_KEY: API_KEY, QTM4J_REGION: REGION },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

// Call a tool, return { ok, text, isError }
async function call(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) return { ok: false, text: JSON.stringify(res.error), isError: true };
  const c = res.result?.content?.[0]?.text ?? "";
  const isError = res.result?.isError === true;
  return { ok: !isError, text: c, isError };
}
function j(text) { try { return JSON.parse(text); } catch { return null; } }

const results = [];
function rec(tool, ok, info) {
  results.push({ tool, status: ok ? "pass" : "FAIL", info: (info || "").slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${tool}  ${ok ? "" : "→ " + (info || "").slice(0, 200)}`);
}

const F = {}; // fixtures

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "audit", version: "1" },
  });
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`Server exposes ${toolNames.length} tools\n`);

  // ---------- LOOKUPS ----------
  for (const [name, args] of [
    ["qtm4j_get_projects", {}],
    ["qtm4j_get_priorities", { projectId: PROJECT }],
    ["qtm4j_get_priority_icons", {}],
    ["qtm4j_get_statuses", { projectId: PROJECT, module: "testcase" }],
    ["qtm4j_get_environments", { projectId: PROJECT }],
    ["qtm4j_get_builds", { projectId: PROJECT }],
    ["qtm4j_get_labels", { projectId: PROJECT }],
    ["qtm4j_get_components", { projectId: PROJECT }],
    ["qtm4j_get_execution_results", { projectId: PROJECT }],
    ["qtm4j_get_custom_fields", { projectId: PROJECT, module: "testcase" }],
    ["qtm4j_get_parameters", { projectId: PROJECT }],
    ["qtm4j_get_user_permissions", { projectId: PROJECT }],
  ]) {
    const r = await call(name, args);
    rec(name, r.ok, r.text);
    if (name === "qtm4j_get_statuses" && r.ok) {
      const d = j(r.text); F.statuses = d?.data ?? d;
    }
    if (name === "qtm4j_get_priorities" && r.ok) {
      const d = j(r.text); F.priorities = d?.data ?? d;
    }
    if (name === "qtm4j_get_execution_results" && r.ok) {
      const d = j(r.text); F.execResults = d?.data ?? d;
    }
  }

  const statusId = F.statuses?.[0]?.id;
  const priorityId = F.priorities?.[0]?.id;
  const passResult = (F.execResults || []).find((x) => /pass/i.test(x.name)) || F.execResults?.[0];

  // ---------- FIXTURES: folders ----------
  let r = await call("qtm4j_create_folder", { projectId: PROJECT, folderType: "TESTCASE", folderName: "audit-tmp-" + Date.now(), parentId: 0 });
  rec("qtm4j_create_folder", r.ok, r.text);
  F.tcFolder = j(r.text)?.id ?? j(r.text)?.data?.id;

  // ---------- TEST CASES ----------
  r = await call("qtm4j_create_test_case", { projectId: PROJECT, summary: "audit-tc-" + Date.now(), precondition: "p", priority: priorityId, status: statusId, folderId: F.tcFolder });
  rec("qtm4j_create_test_case", r.ok, r.text);
  let tc = j(r.text); F.tcId = tc?.id ?? tc?.data?.id; F.tcKey = tc?.key ?? tc?.data?.key;

  r = await call("qtm4j_get_test_case", { id: F.tcKey || F.tcId });
  rec("qtm4j_get_test_case", r.ok, r.text);

  r = await call("qtm4j_get_test_case_version", { id: F.tcKey || F.tcId, versionNo: "latest" });
  rec("qtm4j_get_test_case_version", r.ok, r.text);

  r = await call("qtm4j_search_test_cases", { projectId: PROJECT, folderId: F.tcFolder });
  rec("qtm4j_search_test_cases", r.ok, r.text);

  r = await call("qtm4j_update_test_case", { id: F.tcId, versionNo: 1, summary: "audit-tc-updated" });
  rec("qtm4j_update_test_case", r.ok, r.text);

  r = await call("qtm4j_create_test_steps", { id: F.tcId, versionNo: 1, steps: [{ stepDetails: "s1", expectedResult: "e1" }, { stepDetails: "s2" }] });
  rec("qtm4j_create_test_steps", r.ok, r.text);
  let steps = j(r.text); F.stepId = Array.isArray(steps) ? steps[0]?.id : steps?.data?.[0]?.id;

  r = await call("qtm4j_get_test_steps", { id: F.tcId, versionNo: 1 });
  rec("qtm4j_get_test_steps", r.ok, r.text);
  if (!F.stepId) { const d = j(r.text); F.stepId = (d?.data ?? d)?.[0]?.id; }

  r = await call("qtm4j_update_test_steps", { id: F.tcId, versionNo: 1, steps: [{ id: F.stepId, stepDetails: "s1-upd" }] });
  rec("qtm4j_update_test_steps", r.ok, r.text);

  r = await call("qtm4j_create_test_case_version", { id: F.tcId, copyFromVersion: 1 });
  rec("qtm4j_create_test_case_version", r.ok, r.text);

  r = await call("qtm4j_bulk_update_test_cases", { projectId: PROJECT, fields: { priority: priorityId }, testCaseIds: [F.tcId] });
  rec("qtm4j_bulk_update_test_cases", r.ok, r.text);

  // second folder for move
  r = await call("qtm4j_create_folder", { projectId: PROJECT, folderType: "TESTCASE", folderName: "audit-tmp2-" + Date.now(), parentId: 0 });
  F.tcFolder2 = j(r.text)?.id ?? j(r.text)?.data?.id;
  r = await call("qtm4j_move_test_cases", { projectId: PROJECT, selectedFolderId: F.tcFolder, targetFolderId: F.tcFolder2, testcaseIds: [F.tcId] });
  rec("qtm4j_move_test_cases", r.ok, r.text);

  // clone
  r = await call("qtm4j_clone_test_cases", { testCaseIds: [F.tcId], projectId: PROJECT, folderId: F.tcFolder2 });
  rec("qtm4j_clone_test_cases", r.ok, r.text);

  // ---------- TEST CYCLES ----------
  r = await call("qtm4j_create_test_cycle", { projectId: PROJECT, summary: "audit-cycle-" + Date.now() });
  rec("qtm4j_create_test_cycle", r.ok, r.text);
  let cyc = j(r.text); F.cycleId = cyc?.id ?? cyc?.data?.id; F.cycleKey = cyc?.key ?? cyc?.data?.key;

  r = await call("qtm4j_get_test_cycle", { id: F.cycleKey || F.cycleId });
  rec("qtm4j_get_test_cycle", r.ok, r.text);
  if (!F.cycleId) { const d = j(r.text); F.cycleId = d?.id ?? d?.data?.id; }

  r = await call("qtm4j_search_test_cycles", { projectId: PROJECT });
  rec("qtm4j_search_test_cycles", r.ok, r.text);

  r = await call("qtm4j_update_test_cycle", { id: F.cycleId, description: "audit-upd" });
  rec("qtm4j_update_test_cycle", r.ok, r.text);

  // ---------- EXECUTIONS ----------
  r = await call("qtm4j_link_test_cases_to_cycle", { id: F.cycleId, testCases: [{ id: F.tcId, versionNo: 1 }] });
  rec("qtm4j_link_test_cases_to_cycle", r.ok, r.text);

  r = await call("qtm4j_get_test_cycle_executions", { id: F.cycleId });
  rec("qtm4j_get_test_cycle_executions", r.ok, r.text);
  let ex = j(r.text); let row = (ex?.data ?? [])[0];
  F.mapId = row?.testCycleTestCaseMapId; F.execId = row?.testCaseExecutionId;

  if (F.mapId) {
    r = await call("qtm4j_get_test_execution", { cycleId: F.cycleId, testCycleTestCaseMapId: F.mapId, testCaseExecutionId: F.execId });
    rec("qtm4j_get_test_execution", r.ok, r.text);
  } else rec("qtm4j_get_test_execution", false, "no mapId from executions");

  r = await call("qtm4j_update_test_execution", { cycleId: F.cycleId, testCaseExecutionId: F.execId, executionResultId: passResult?.id, comment: "audit-comment", testCycleTestCaseMapId: F.mapId });
  rec("qtm4j_update_test_execution", r.ok, r.text);

  if (F.mapId) {
    r = await call("qtm4j_bulk_update_test_executions", { cycleId: F.cycleId, testCycleTestCaseMapIds: [F.mapId], executionResultId: passResult?.id });
    rec("qtm4j_bulk_update_test_executions", r.ok, r.text);
  } else rec("qtm4j_bulk_update_test_executions", false, "no mapId");

  // step execution: need testStepExecutionId — fetch execution teststeps via raw endpoint not exposed; try from executions detail
  // Attempt: get teststeps of the execution through the cycle executions (not always present). Mark skipped if unavailable.
  let stepExecId = null;
  if (F.cycleId && F.execId) {
    const raw = await rawGet(`/testcycles/${F.cycleId}/testcase-executions/${F.execId}/teststeps`);
    stepExecId = (raw?.data ?? raw)?.[0]?.testStepExecutionId ?? (raw?.data ?? raw)?.[0]?.id;
  }
  if (stepExecId) {
    r = await call("qtm4j_update_test_step_execution", { cycleId: F.cycleId, testStepExecutionId: stepExecId, executionResultId: passResult?.id, comment: "audit-step" });
    rec("qtm4j_update_test_step_execution", r.ok, r.text);
  } else rec("qtm4j_update_test_step_execution", false, "could not resolve testStepExecutionId (steps deleted earlier?)");

  // attachments
  r = await call("qtm4j_list_execution_attachments", { cycleId: F.cycleId, testcaseExecutionId: F.execId });
  rec("qtm4j_list_execution_attachments", r.ok, r.text);

  // upload a tiny temp file
  const tmpFile = "/tmp/audit-attach.txt";
  await import("node:fs").then((fs) => fs.writeFileSync(tmpFile, "audit attachment body"));
  r = await call("qtm4j_upload_execution_attachment", { cycleId: String(F.cycleId), testcaseExecutionId: F.execId, projectId: PROJECT, filePath: tmpFile });
  rec("qtm4j_upload_execution_attachment", r.ok, r.text);
  // list again to find attachment id
  await new Promise((res) => setTimeout(res, 4000));
  r = await call("qtm4j_list_execution_attachments", { cycleId: F.cycleId, testcaseExecutionId: F.execId });
  let atts = j(r.text); F.attId = (atts?.data ?? atts)?.[0]?.id;
  if (F.attId) {
    r = await call("qtm4j_delete_execution_attachment", { cycleId: F.cycleId, testcaseExecutionId: F.execId, attachmentIds: [F.attId] });
    rec("qtm4j_delete_execution_attachment", r.ok, r.text);
  } else rec("qtm4j_delete_execution_attachment", false, "no attachment id found to delete");

  // ---------- TEST PLANS ----------
  r = await call("qtm4j_create_test_plan", { projectId: PROJECT, summary: "audit-plan-" + Date.now() });
  rec("qtm4j_create_test_plan", r.ok, r.text);
  let pl = j(r.text); F.planId = pl?.id ?? pl?.data?.id; F.planKey = pl?.key ?? pl?.data?.key;

  r = await call("qtm4j_get_test_plan", { id: F.planKey || F.planId });
  rec("qtm4j_get_test_plan", r.ok, r.text);
  if (!F.planId) { const d = j(r.text); F.planId = d?.id ?? d?.data?.id; }

  r = await call("qtm4j_search_test_plans", { projectId: PROJECT });
  rec("qtm4j_search_test_plans", r.ok, r.text);

  r = await call("qtm4j_update_test_plan", { id: F.planId, priority: F.priorities?.[0]?.name });
  rec("qtm4j_update_test_plan", r.ok, r.text);

  r = await call("qtm4j_link_test_cycles_to_plan", { id: F.planId, testcycleIds: [Number(F.cycleId)] });
  rec("qtm4j_link_test_cycles_to_plan", r.ok, r.text);

  r = await call("qtm4j_get_linked_test_cycles", { id: F.planId });
  rec("qtm4j_get_linked_test_cycles", r.ok, r.text);

  r = await call("qtm4j_unlink_test_cycles_from_plan", { id: F.planId, testcycleIds: [Number(F.cycleId)] });
  rec("qtm4j_unlink_test_cycles_from_plan", r.ok, r.text);

  // ---------- FOLDERS extra ----------
  r = await call("qtm4j_list_folders", { projectId: PROJECT, folderType: "TESTCASE", folderId: F.tcFolder });
  rec("qtm4j_list_folders", r.ok, r.text);
  r = await call("qtm4j_search_folders", { projectId: PROJECT, module: "testcase", folderName: "audit-tmp" });
  rec("qtm4j_search_folders", r.ok, r.text);
  r = await call("qtm4j_edit_folder", { projectId: PROJECT, module: "testcase", folderId: F.tcFolder, description: "audit-edit" });
  rec("qtm4j_edit_folder", r.ok, r.text);

  // ---------- AUTOMATION & REQUIREMENTS ----------
  // automation rule key unknown; attempt link with a probe to see error behavior
  r = await call("qtm4j_link_automation_rule", { cycleId: F.cycleId, automationRuleKey: "AUDIT-NONEXISTENT" });
  rec("qtm4j_link_automation_rule", r.ok, r.text + " (probe; expect graceful error if no rule)");
  r = await call("qtm4j_unlink_automation_rule", { cycleId: F.cycleId, automationRuleKey: "AUDIT-NONEXISTENT" });
  rec("qtm4j_unlink_automation_rule", r.ok, r.text + " (probe)");
  r = await call("qtm4j_run_automation_rules", { automationRuleKey: "AUDIT-NONEXISTENT", projectId: Number(PROJECT), testCycleId: String(F.cycleId) });
  rec("qtm4j_run_automation_rules", r.ok, r.text + " (probe)");

  // requirement link: requires a real Jira issue numeric id; probe
  r = await call("qtm4j_link_test_cases_to_requirement", { requirementId: 999999999, testcases: [{ id: F.tcId, versionNo: 1 }] });
  rec("qtm4j_link_test_cases_to_requirement", r.ok, r.text + " (probe)");
  r = await call("qtm4j_unlink_test_cases_from_requirement", { requirementId: 999999999, testcases: [{ id: F.tcId, versionNo: 1 }] });
  rec("qtm4j_unlink_test_cases_from_requirement", r.ok, r.text + " (probe)");

  // ---------- DESTRUCTIVE / CLEANUP ----------
  r = await call("qtm4j_delete_test_steps", { id: F.tcId, versionNo: 1, deleteAll: true });
  rec("qtm4j_delete_test_steps", r.ok, r.text);

  r = await call("qtm4j_delete_test_cycle", { id: F.cycleId });
  rec("qtm4j_delete_test_cycle", r.ok, r.text);
  r = await call("qtm4j_delete_test_plan", { id: F.planId });
  rec("qtm4j_delete_test_plan", r.ok, r.text);

  r = await call("qtm4j_archive_test_case", { id: F.tcId });
  rec("qtm4j_archive_test_case", r.ok, r.text);
  r = await call("qtm4j_delete_test_case", { id: F.tcId });
  rec("qtm4j_delete_test_case", r.ok, r.text);

  // delete clone(s) in folder2 + the test case there, then folders. Best-effort cleanup.
  F.cleanupNote = "Folders audit-tmp/audit-tmp2 + any clone left; deleting clone(s)";
  const search = await call("qtm4j_search_test_cases", { projectId: PROJECT, folderId: F.tcFolder2, maxResults: 50 });
  const sj = j(search.text); const leftover = (sj?.data ?? []);
  for (const lc of leftover) {
    await call("qtm4j_archive_test_case", { id: lc.id });
    await call("qtm4j_delete_test_case", { id: lc.id });
  }
  // delete folders via raw DELETE (no tool exists)
  for (const fid of [F.tcFolder, F.tcFolder2]) {
    if (fid) await rawDelete(`/projects/${PROJECT}/testcase-folders/${fid}`);
  }

  // ---------- SUMMARY ----------
  console.log("\n===== AUDIT SUMMARY =====");
  const fails = results.filter((x) => x.status === "FAIL");
  console.log(`Total: ${results.length}  Pass: ${results.length - fails.length}  FAIL: ${fails.length}`);
  console.log("\nFAILURES:");
  for (const f of fails) console.log(`  ${f.tool}: ${f.info}`);
  await import("node:fs").then((fs) => fs.writeFileSync("/tmp/audit-results.json", JSON.stringify(results, null, 2)));
  console.log("\nFixtures:", JSON.stringify(F));
}

async function rawGet(path) {
  const base = REGION === "AU" ? "https://syd-qtmcloud.qmetry.com/rest/api/latest" : "https://qtmcloud.qmetry.com/rest/api/latest";
  const res = await fetch(base + path, { headers: { apiKey: API_KEY, Accept: "application/json" } });
  try { return await res.json(); } catch { return null; }
}
async function rawDelete(path) {
  const base = REGION === "AU" ? "https://syd-qtmcloud.qmetry.com/rest/api/latest" : "https://qtmcloud.qmetry.com/rest/api/latest";
  const res = await fetch(base + path, { method: "DELETE", headers: { apiKey: API_KEY, "Content-Type": "application/json" }, body: "{}" });
  return res.status;
}

main().then(() => { child.kill(); process.exit(0); }).catch((e) => { console.error(e); child.kill(); process.exit(1); });
