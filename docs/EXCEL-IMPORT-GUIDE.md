# Excel → QMetry bulk-import guide

How to import test cases from one or more Excel workbooks into QMetry using `scripts/import-xlsx-to-qmetry.py`, plus the gotchas this repo has already paid for.

## TL;DR

```bash
# 1. Put workbooks under a folder like Input/<batch-name>/<subfolder>/*.xlsx
# 2. Generate a fresh QMetry API key (avatar → API Keys → Generate) and export it
export QTM4J_API_KEY=<key>
# 3. Dry-run first to confirm parsing
python3 scripts/import-xlsx-to-qmetry.py --input "Input/<batch-name>" --dry-run
# 4. Full run
python3 scripts/import-xlsx-to-qmetry.py --input "Input/<batch-name>"
# 5. If you change the parser or discover a column-mapping mistake, fix in place
python3 scripts/import-xlsx-to-qmetry.py --input "Input/<batch-name>" --fix-existing
```

Every run prints a **PLAN** header first — `N workbooks, M cases, S steps` — *before* any QMetry call. Use it as the upfront sanity check: if the step count looks low compared to what you eyeball in the workbooks, something is off (likely a schema mismatch — add a header alias) and you should abort with Ctrl-C.

The script is idempotent: it writes every result to `scripts/import-<batch>.log.csv` and skips already-imported `(workbook, e2e_id)` pairs on rerun.

## Folder model

```
<parent-folder-id>          (--parent-folder-id, e.g. Refactored_E2E = 0)
  <root-folder-name>/       (--root-folder-name, defaults to basename of --input)
    <subdirectory>/         (one per direct child of --input)
      <workbook-stem>/      (filename minus _E2E_TestCases.xlsx)
        <test cases live here>
```

For each `.xlsx` we expect a sheet named **`E2E_TestCases`**. Anything else in the file is ignored.

## Expected sheet structure

Header row drives column detection — **column positions are NOT hard-coded**. See `HEADER_ALIASES` in the script. The fields it tries to find:

| Field | Aliases (case-insensitive, exact match after stripping) |
|---|---|
| `e2e_id` (required) | `E2E Test ID`, `E2E TC ID`, `Test ID`, `TC ID` |
| `summary` (required) | `E2E Test Name`, `Title`, `Summary`, `Test Case Name` |
| `category` | `Category` |
| `test_type` | `Test Type`, `Type` |
| `priority` | `Priority` |
| `notes` (precondition) | `Notes / Endpoint`, `Notes`, `Endpoint`, `Precondition` |
| `step_num` | `Step #`, `Step No`, `Step Number` |
| `action` (required) | `Step Summary (Action)`, `Step Summary`, `Step`, `Action`, `Step Description` |
| `expected` | `Expected Result`, `Expected`, `Expected Outcome` |

If the workbook has a new header you've never seen, **add an alias to `HEADER_ALIASES`** rather than rewriting parsing logic. If `e2e_id` or `action` isn't found, the file is skipped with a stderr warning.

### Row grouping

Each test case starts on a row where the `e2e_id` column matches `^([A-Z][A-Z0-9]*-)+\d+$` AND contains `E2E` as a hyphen-separated segment. Subsequent rows with an empty `e2e_id` are treated as additional steps of the current case. A row whose `e2e_id` is non-empty but doesn't match the regex (e.g. `review done`, `n/a`, `TBD`) is a hard reset — closes the current case, does not start a new one.

### Step extraction

A row contributes a step iff its `action` or `expected` cell is non-empty. Step numbers (`step_num`) are not used by QMetry — order in the sheet is what matters.

## Field mapping to QMetry

| Workbook | QMetry | Notes |
|---|---|---|
| `e2e_id` + `summary` | `summary` | Joined as `"<e2e_id> \| <summary>"`, truncated to 255 chars |
| `priority` (P1–P4) | `priority` (integer ID) | Mapped via `PRIORITY_MAP`. Anything else → `DEFAULT_PRIORITY_ID` (Medium) |
| `notes` | `precondition` | Empty if absent |
| `test_type == "API"` | custom field `API Test` = Yes | Anything else → No. Custom field IDs are tenant-specific |
| (n/a) | `status` | `--status-id` (default 0 = Done) |
| (n/a) | `components` | `--component-id` (default `0` = CBS). Pass `--component-id` repeatedly to attach multiple |
| `action`, `expected` per row | `teststeps` | `stepDetails`, `expectedResult` |

## CLI

```
--input PATH                Root folder of workbooks (default: Input/CBS 2)
--parent-folder-id N        QMetry folder ID to nest under (default: Refactored_E2E)
--root-folder-name NAME     Top folder name (default: basename of --input)
--project-id N              Default: 10000 (FS)
--component-id N            Repeatable. Default: 0 (CBS). Empty to attach none.
--status-id N               Default: 0 (Done)
--api-test-field-id ID      Custom-field id (default qcf_0; empty to skip)
--api-test-yes / --api-test-no  Option IDs for the Yes/No radio
--log PATH                  Default: scripts/import-<input-name>.log.csv
--only SUBSTR               Limit to workbooks whose stem contains this substring
--dry-run                   Parse and print; no QMetry calls
--fix-existing              For rows already in --log: PUT precondition, wipe steps, re-add
```

## Gotchas, paid for in blood

Read this *before* running on a new dataset.

### 1. Schemas drift across workbooks
The CBS-2 batch had two different column layouts that looked plausible at a glance. The first run used the wrong columns for half the workbooks (steps came out as 1 garbage step instead of 50+) and didn't crash — output looked merely "thin". **Always run `--dry-run` first**; eyeball the parsed step counts before committing. Add aliases to `HEADER_ALIASES` when you see new headers.

### 2. Excel lock files crash the parser
A file like `~$CBS_Backup_CRUD.xlsx` appears any time someone has the workbook open in Excel. It's not a real zip, openpyxl chokes, and (worse) the script's directory walk had already created an empty QMetry folder named `~$CBS_Backup_CRUD` before it crashed. The script now skips `~$*` and `.*` prefixed files — leave that filter in.

### 3. Junk rows in column A
Manual reviewers sometimes leave a final row like `review done`, `complete`, `n/a` in column A. The script's regex filter rejects anything that isn't a clean `<PREFIX>-...-N` ending with digits AND containing `E2E`. If you ever import a batch whose IDs don't contain `E2E`, weaken the regex deliberately — don't comment it out.

### 4. Summary cap is 255 chars
QMetry rejects with `412 Validation failed: Test Case summary cannot be more than 255 characters`. The script truncates and appends `...`. If you need full titles, push the long form into description/precondition instead.

### 5. Priority is mandatory
First-time projects often reject test-case creation with `412 Priority is/are mandatory System Field(s) for Test Case module`. Always include `priority` in the body. The default of Medium covers workbooks that don't have a Priority column.

### 6. Custom-field radios take option IDs, not labels
`{"customFields":[{"id":"qcf_0","value":"Yes"}]}` returns `404 Option value with ID Yes is not present.` — QMetry expects the integer option ID as a *string* (e.g. `"0"`). Discover them with `GET /projects/{projectId}/testcase-custom-fields` and read the `options[].id`.

### 7. Components have different shapes on create vs update
- **Create**: `"components": [0]` (plain array of IDs).
- **Update (PUT)**: `"components": {"add":[0], "delete":[]}`. Bare array returns `400 Invalid request body`; `{mode:"replace",values:[]}` returns a different 400. The `add/delete` shape is the one that works.

### 8. Steps endpoint takes a bare array, not `{steps:[…]}`
`POST /testcases/{id}/versions/1/teststeps` body is `[{stepDetails, expectedResult}, …]`. Wrapping it in `{steps: [...]}` silently misbehaves.

### 9. Test cases can't be deleted while active
Trying `DELETE /testcases/{key}/versions/1` returns `400 You can not delete active Test Case(s), You need to archive them before performing delete operation.` Archive-via-PUT (`{archived:true}`) returns 204 but in practice didn't unblock delete in this tenant. **Easiest path: delete in the QMetry UI** (`⋮ → Delete`).

### 10. API keys can rotate mid-session
The MCP server caches the key it was started with, so it can keep working even after the key is revoked server-side — while a fresh curl/script with the same string gets 401. If only direct calls fail, **regenerate** the key in the QMetry UI and re-export. Don't chase phantom client bugs. Verify with:
```bash
curl -s -H "apiKey: $QTM4J_API_KEY" -H "Accept: application/json" \
  "https://qtmcloud.qmetry.com/rest/api/latest/projects/<id>/testcase-folders" \
  -o /dev/null -w "%{http_code}\n"
```

### 11. AU region uses a different host
`https://syd-qtmcloud.qmetry.com` (not `qtmcloud-au.…`). The script picks this up from `QTM4J_REGION=AU`.

### 12. Read the PLAN before you let it write
Every non-dry run prints a planning block:
```
PLAN: 24 workbook(s), 90 test case(s), 2635 step(s)  →  project 10000, parent folder 0 ('CBS 2')
  largest workbooks by step count: Backup_policy/BackUp_Policy_Crud=846, ...
  sample test cases (smallest/median/largest by step count) — verify these look right:
    • Backup/CBS_Backup_CRUD  CBSBC-E2E-002  steps=1  pri=0  type=API
        summary: Cross-Project Security — Cannot Create Backup …
        step 1:  Given a valid auth token for Project A; attempt to POST …
    • …
```
Two things to check:
1. **Totals** — if you expected ~2,000+ steps and see 150, **schema-mismatch alarm** → Ctrl-C, add a header alias in `HEADER_ALIASES`, re-run `--dry-run`, then proceed.
2. **Samples** — read the summary + first-step text. If the summary looks like a step description (or vice-versa), columns are misaligned. Fix `HEADER_ALIASES` before continuing.

Workbooks that parsed 0 cases get a `⚠` flag listed separately.

### 13. `--fix-existing` is the recovery hatch
If the parser changes after an import (new alias, regex tweak, schema discovered), don't try to delete and re-import. Run `--fix-existing` instead — it re-parses each workbook with the current parser, then PUTs precondition and replaces steps in-place for every `(workbook, e2e_id)` already in the log. Idempotent; safe to rerun.

## Quick reference — useful field IDs (Generic Project, project 10000)

| Field | ID(s) |
|---|---|
| **Priorities** | Blocker `0`, High `0`, Medium `0`, Low `0` |
| **Statuses** (test-case) | To Do `0`, In Progress `0`, Done `0` |
| **Component CBS** | `0` |
| **Custom field "API Test"** | field `qcf_0`; options Yes `0`, No `0` |
| **Custom field "Automation Status"** | field `qcf_0` (dropdown — fetch options if you need to set it) |

To regenerate these for another project, hit:
- `GET /projects/{id}/priorities`
- `GET /projects/{id}/testcase-statuses`
- `GET /projects/{id}/components`
- `GET /projects/{id}/testcase-custom-fields`
