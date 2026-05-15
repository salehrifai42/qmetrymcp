---
name: xlsx-to-qmetry
description: Bulk-import test cases from one or more Excel workbooks into QMetry (QTM4J). Use whenever the user drops a folder of `.xlsx` files under `Input/` and asks to upload, import, push, or sync test cases into QMetry. Wraps scripts/import-xlsx-to-qmetry.py — handles folder creation, schema auto-detection, idempotent reruns, and recovery via --fix-existing.
user-invocable: true
---

# xlsx → QMetry import

Triggered when the user wants to push a batch of Excel test cases into QMetry. Reference: [docs/EXCEL-IMPORT-GUIDE.md](../../../docs/EXCEL-IMPORT-GUIDE.md).

**Folder collapse rule:** if a category subfolder contains exactly one workbook, the workbook-stem level is skipped — test cases land directly under the category folder. Categories with ≥2 workbooks keep the full `category/workbook-stem/<cases>` layout. The dry-run plan tags collapsed entries with `[flatten]`.

## Workflow (follow exactly)

### Step 1 — Ask the user, in one batch, what's tenant-specific

Before any parsing, confirm:

1. **Input folder path** (e.g. `Input/<batch-name>`) — must exist on disk.
2. **QMetry parent folder ID** to nest under (default from `config.json` → `xlsxImport.parentFolderId`).
3. **Component(s)** to attach (default from `config.json` → `xlsxImport.componentIds`; empty list = none).
4. **Status** for new test cases (default from `config.json` → `xlsxImport.statusId`).
5. Whether the **API Test custom field** rule (`Test Type == "API"` → Yes, else No) still applies. If not, ask which custom fields they want set instead.

Don't assume defaults from a previous run — different batches go into different folders / components.

### Step 2 — Sanity check the input

```bash
ls "<input-folder>"
find "<input-folder>" -name "*.xlsx" | wc -l
```

If the count is zero, stop and ask the user.

### Step 3 — Verify the API key is current

The API key in `config.json` and `$QTM4J_API_KEY` can be stale (the running MCP server caches its own copy). Always verify with a direct curl:

```bash
curl -s -H "apiKey: $QTM4J_API_KEY" -H "Accept: application/json" \
  "https://qtmcloud.qmetry.com/rest/api/latest/projects/<project-id>/testcase-folders" \
  -o /dev/null -w "%{http_code}\n"
```

If not 200, ask the user to regenerate (avatar → API Keys → Generate) and save to `config.json`. Then:

```bash
export QTM4J_API_KEY=$(python3 -c "import json; print(json.load(open('config.json'))['connection']['apiKey'])")
```

**Bash vs MCP within this workflow:**
- xlsx parsing, the dry-run PLAN, idempotent CSV logging, and the create/teststeps loop stay in `scripts/import-xlsx-to-qmetry.py` — MCP can't read `.xlsx`, and looping 100+ cases through individual MCP tool calls is too noisy in context.
- One-off reads (list components, list folders, fetch a single test case to verify) → use the MCP `qtm4j_*` tools, not curl.
- The API-key health check above stays as a direct curl — the MCP server caches the key at startup and can keep working even when the key has rotated, masking the problem. curl talks to the live API.

### Step 4 — Always dry-run FIRST

```bash
python3 scripts/import-xlsx-to-qmetry.py --input "<input>" --parent-folder-id <id> --dry-run
```

Read the **PLAN** header carefully. It prints three things:

1. Totals: `N workbooks, M cases, S steps`.
2. Largest workbooks by step count (sanity dial).
3. **Three sample test cases** (smallest / median / largest by step count) with summary + first-step preview.

**Show all three to the user. Ask them to confirm both the totals and the sample summaries/steps look right.** If a sample's summary reads like a step description, columns are mis-mapped — abort and fix `HEADER_ALIASES`.

If any workbook shows `⚠ parsed 0 cases`, open it, look at the header row, and add the new header alias to `HEADER_ALIASES`. Don't proceed until every workbook parses cleanly.

### Step 5 — Sample run (2 cases) for human preview

Before committing the full batch, write **only 2 test cases** so the user can eyeball them in the QMetry UI. This catches surprises the dry-run plan can't — wrong target folder, custom-field misconfiguration, mangled multi-line cells, formatting issues.

```bash
python3 scripts/import-xlsx-to-qmetry.py \
  --input "<input>" \
  --parent-folder-id <id> \
  --component-id <id> \
  --samples 2
```

The script stops after the first 2 successful creates. Tell the user the QMetry keys (e.g. `<PROJ>-TC-NNNNN`) and ask them to open one in the UI and confirm: summary, precondition, steps, components, custom fields, priority. **Wait for explicit "looks good" before continuing.** If anything is wrong, patch the script (or HEADER_ALIASES, or defaults) and either re-run `--samples 2` against a fresh log path, or run `--fix-existing` to overwrite the 2 samples in place.

### Step 6 — Full run

```bash
python3 scripts/import-xlsx-to-qmetry.py \
  --input "<input>" \
  --parent-folder-id <id> \
  --component-id <id>  # repeat for multiple, or omit entirely
```

The script is idempotent — the 2 samples already in the log are skipped automatically. Compare the `created=` + `skipped=` totals against the PLAN. If they match, you're done.

### Step 7 — Verify in QMetry, propose `--fix-existing` if needed

Ask the user to spot-check one or two test cases. If anything's wrong (missing custom field, wrong precondition, missing steps), patch the script and run:

```bash
python3 scripts/import-xlsx-to-qmetry.py --input "<input>" --fix-existing
```

This re-parses every logged case and overwrites precondition + steps in place. Idempotent and safe to rerun.

## When a workbook fails the schema check, INSPECT it before reporting "wrong schema"

Open it with `openpyxl`, print sheet names + header + first 5 rows with non-empty cells. Different batches use different column names; the data is usually still there. The IAM batch (2026-05-15) had 4 workbooks with a `TestCases` sheet (`Work Key | Summary | ... | Step Summary | Folder | ...`) that the initial pass dismissed as "0 cases" until the user pushed back — they were fully parseable Jira exports of existing `PROJ-TC-*` cases.

After inspecting, decide: extend `HEADER_ALIASES`, switch to **move-not-import** (see "Jira-export workbooks" below), or genuinely skip.

## Jira-export workbooks (Work Key + TestCases sheet) — move, don't import

Some batches mix in workbooks shaped like a Jira/QMetry export — single sheet `TestCases`, `Work Key` column with existing `PROJ-TC-*` keys, plus `Step Summary`, `Expected Result`, `Folder`, etc. **These cases already exist in QMetry.** Re-importing creates duplicates and loses cycle / requirement / execution linkages. Instead:

1. Parse the workbook to collect `Work Key` per category folder.
2. Look up each internal UID: `POST /testcases/search?maxResults=2` body `{"filter": {"projectId": <id>, "key": "PROJ-TC-..."}}` — one key at a time (array filter returns 400). The hit's `id` field is the UID.
3. Show the user the move plan (key → from → to) and get explicit go-ahead.
4. `PUT /testcases/move` body `{"projectId": <id>, "selectedFolderId": -1, "targetFolderId": <dst>, "testcaseIds": [<uid>...]}`. Group by destination folder, one call per folder.
5. Verify: `POST /testcases/search` body `{"filter": {"projectId":..., "folderId": <dst>}}` and confirm the keys are present.
6. Spot-check one case against the sheet (summary, step count, step text) using `GET /testcases/{uid}/versions/latest` and `POST /testcases/{uid}/versions/1/teststeps/search?startAt=0&maxResults=200` body `{}` (bare empty object, NOT `{"filter":{}}` — that returns 400).

Move is a pointer change — the case leaves its source folder. If the user wants the case in both old and new locations, that's a clone, not a move — confirm intent before acting.

## Authorization gate for destructive QMetry calls

Test-case creates, moves, updates, deletes, archives, and automation runs need an **explicit imperative** in the user's message ("do it", "go", "yes move", "proceed"). Leading questions ("moving is best right?", "should we…?") are NOT consent — Claude Code's classifier will block the call. Lay out the concrete plan (IDs, target folders, exact calls) and wait for an unambiguous green light. Read-only calls (search, list, get, fetch) don't need this gate.

## Mistakes to NEVER repeat

These all happened during the CBS 2 import. They're listed in [docs/EXCEL-IMPORT-GUIDE.md §Gotchas](../../../docs/EXCEL-IMPORT-GUIDE.md#gotchas-paid-for-in-blood). Highlights:

- **Never hard-code column indices.** Always look up by header name via `HEADER_ALIASES`. Different workbooks in the same batch can have totally different layouts.
- **Always dry-run and read the PLAN totals** before any write. A schema mismatch is silent — the import won't crash, it'll just create gutted test cases.
- **Skip `~$*` lock files.** Excel creates these whenever a workbook is open in Excel.
- **Filter junk col-A values** with the `_is_valid_e2e_id` regex. Don't trust the spreadsheet to have only real IDs.
- **Summary cap = 255 chars.** Pre-truncate.
- **Custom-field radios take option IDs (as strings), not labels.** Discover via `GET /projects/{id}/testcase-custom-fields`.
- **Components shape differs on create vs update.** Create: `[<id>]`. Update via PUT: `{"add":[<id>],"delete":[]}`.
- **Teststeps body is a bare array**, not `{steps:[…]}`.
- **You can't delete an active test case** via API in this tenant — archive-then-delete is unreliable. Tell the user to delete via UI.
- **API key rotation kills curl/direct calls** but the long-running MCP keeps working. If only direct fails, ask for a fresh key.

## When the user has questions or new requirements

**Ask, don't guess.** Different batches genuinely have different fields, schemas, target folders, components. A wrong default silently corrupts hundreds of records. If anything is unclear (column meaning, which workbooks form one folder, what to do with empty workbooks, which Jira stories to link), pause and confirm.

## Final report format

Always end with a count summary like:

```
| Workbooks processed | N  |
| Test cases imported | M  |
| Total steps         | S  |
| Failures            | 0  |
| Stray cases         | 0  |
```

Plus folder IDs and the log path so the user can audit or rerun.
