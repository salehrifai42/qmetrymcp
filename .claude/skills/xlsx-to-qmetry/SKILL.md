---
name: xlsx-to-qmetry
description: Bulk-import test cases from one or more Excel workbooks into QMetry (QTM4J). Use whenever the user drops a folder of `.xlsx` files under `Input/` and asks to upload, import, push, or sync test cases into QMetry. Wraps scripts/import-xlsx-to-qmetry.py — handles folder creation, schema auto-detection, idempotent reruns, and recovery via --fix-existing.
user-invocable: true
---

# xlsx → QMetry import

Triggered when the user wants to push a batch of Excel test cases into QMetry. Reference: [docs/EXCEL-IMPORT-GUIDE.md](../../../docs/EXCEL-IMPORT-GUIDE.md).

## Workflow (follow exactly)

### Step 1 — Ask the user, in one batch, what's tenant-specific

Before any parsing, confirm:

1. **Input folder path** (e.g. `Input/<batch-name>`) — must exist on disk.
2. **QMetry parent folder ID** to nest under (default `0` = `Refactored_E2E` in project 10000, FS).
3. **Component(s)** to attach (default `[0]` = CBS). Empty list is fine.
4. **Status** for new test cases (default `0` = Done).
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

### Step 4 — Always dry-run FIRST

```bash
python3 scripts/import-xlsx-to-qmetry.py --input "<input>" --parent-folder-id <id> --dry-run
```

Read the **PLAN** header it prints first: `N workbooks, M cases, S steps`. **Show those numbers to the user and ask them to confirm.** This is the schema-mismatch detector — if step count looks low, abort.

If any workbook shows `⚠ parsed 0 cases`, that's an unrecognized schema. Open the file, look at the header row, and add the new header alias to `HEADER_ALIASES` in `scripts/import-xlsx-to-qmetry.py`. Don't proceed until every workbook parses cleanly.

### Step 5 — Run

```bash
python3 scripts/import-xlsx-to-qmetry.py \
  --input "<input>" \
  --parent-folder-id <id> \
  --component-id <id>  # repeat for multiple, or omit entirely
```

Compare the `created=` total in the final line against the PLAN. If they match, you're done.

### Step 6 — Verify in QMetry, propose `--fix-existing` if needed

Ask the user to spot-check one or two test cases. If anything's wrong (missing custom field, wrong precondition, missing steps), patch the script and run:

```bash
python3 scripts/import-xlsx-to-qmetry.py --input "<input>" --fix-existing
```

This re-parses every logged case and overwrites precondition + steps in place. Idempotent and safe to rerun.

## Mistakes to NEVER repeat

These all happened during the CBS 2 import. They're listed in [docs/EXCEL-IMPORT-GUIDE.md §Gotchas](../../../docs/EXCEL-IMPORT-GUIDE.md#gotchas-paid-for-in-blood). Highlights:

- **Never hard-code column indices.** Always look up by header name via `HEADER_ALIASES`. Different workbooks in the same batch can have totally different layouts.
- **Always dry-run and read the PLAN totals** before any write. A schema mismatch is silent — the import won't crash, it'll just create gutted test cases.
- **Skip `~$*` lock files.** Excel creates these whenever a workbook is open in Excel.
- **Filter junk col-A values** with the `_is_valid_e2e_id` regex. Don't trust the spreadsheet to have only real IDs.
- **Summary cap = 255 chars.** Pre-truncate.
- **Custom-field radios take option IDs (as strings), not labels.** Discover via `GET /projects/{id}/testcase-custom-fields`.
- **Components shape differs on create vs update.** Create: `[0]`. Update via PUT: `{"add":[0],"delete":[]}`.
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
