# Diagnostics Corpus

Versioned collection of verbatim Verse compiler messages and the extractions
the extension must produce for them. This is the drift detector for Epic
changing error wording between UEFN releases: when a new UEFN version ships,
capture a new corpus folder and the test run shows exactly which extraction
patterns broke.

## Layout

One folder per UEFN release, each with a `diagnostics.json`:

```
test-fixtures/corpus/
    41.10/
        diagnostics.json
    <next UEFN version>/
        diagnostics.json
```

`src/imports/__tests__/diagnosticsCorpus.test.ts` loads every version folder
and asserts, for each entry, the output of both extraction paths.

## Schema

```json
{
    "uefnVersion": "41.10",
    "capturedAt": "2026-07-03",
    "notes": "optional free text",
    "entries": [
        {
            "id": "unique-kebab-slug",
            "source": "captured | book | synthetic",
            "context": "optional: where the message came from",
            "message": "verbatim compiler message, newlines preserved",
            "expected": {
                "suggestions": ["using { /Fortnite.com/Devices }"],
                "optimizePaths": ["/Fortnite.com/Devices"]
            }
        }
    ]
}
```

- `expected.suggestions`: import statements `extractImportSuggestions` must
  return, in order (the auto-import and quick-fix path).
- `expected.optimizePaths`: paths `extractImportsFromDiagnostics` must return
  (the Optimize Imports path). Ambiguous multi-option messages expect `[]`
  here by design.
- `source`: `captured` = recorded from a live UEFN session (highest value),
  `book` = preserved compiler output from the Book of Verse, `synthetic` =
  hand-written shape awaiting live capture. Replace synthetic entries with
  captured ones when the real message is observed.

## Workflow

1. During a smoke session (see `test-fixtures/uefn-smoke/PLAYBOOK.md`), open
   the fixture files so the Verse LSP reports their diagnostics.
2. Run the command **Verse Auto Imports: Capture Diagnostics Corpus**. It
   writes the verbatim diagnostics of all open `.verse` files to a JSON file.
3. Curate the capture into entries: keep one entry per distinct message
   shape, fill in the two `expected` arrays, mark `source: "captured"`.
4. For a new UEFN version, create a new folder rather than editing the old
   one; old folders document what previous compilers emitted.
