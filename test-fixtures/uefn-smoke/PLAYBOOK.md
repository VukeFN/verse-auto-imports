# UEFN Smoke Test Playbook

Manual pre-release verification of the extension against a real UEFN project,
real Verse LSP diagnostics, and real 41.10 digest files. Run this before every
release; it is the gate the automated Jest suite cannot provide (that suite
mocks the entire VS Code and UEFN environment).

Test project: `%USERPROFILE%\Documents\Fortnite Projects\VerseAutoImports`
Project Verse path: `/vukefn@fortnite.com/VerseAutoImports`

Conventions: check the box when the observed behavior matches Expected.
Anything else goes in the Findings table at the bottom, verbatim (exact error
text, exact inserted import), so extractor patterns can be fixed against
reality.

## Phase A: UEFN content setup (once per project)

Asset reflection exposes exactly four asset types to Verse (meshes, textures,
materials, Niagara VFX). Materials are the only type that generates a CLASS in
`Assets.digest.verse`; the rest generate instances. We want every type, at
more than one folder depth, so the digest exercises every declaration shape.

In UEFN, create (names matter -- fixtures and expected digest entries use
them):

- [ ] Existing textures kept: `image1` (Content root), `Folder1/image2`,
      `Folder1/InnerFolder/image3`
- [ ] `Meshes/TestSphere` -- any static mesh, e.g. a sphere from the shapes
      gallery
- [ ] `Materials/TestMaterial` -- a material WITH at least one scalar or
      vector parameter (parameterized materials generate class fields)
- [ ] `VFX/TestVFX` -- any Niagara particle system
- [ ] `Mixed/Deep/TestDeepTexture` -- any texture two folders deep

Then push Verse changes (or Build Verse Code) in UEFN so
`Assets.digest.verse` regenerates, and hand the digest to Claude to record
the exact declaration syntax for all four types. This decides whether
`AssetsDigestParser` still matches the live format (suspected dead against
41.10: it only accepts `Name<public|internal|private> := class/struct`, the
live digest emits `<scoped {...}>` specifiers and instance declarations).

## Phase B: rig setup (each run)

- [ ] Build and install the dev extension: `npm run compile && npx vsce
      package`, then `code --install-extension verse-auto-imports-<ver>.vsix`
      (or let Claude do it). Reload VS Code windows afterwards.
- [ ] Open the project THROUGH UEFN (Verse menu > VS Code) so VS Code loads
      the generated multi-root `VerseAutoImports.code-workspace` -- Content
      plus the digest folders. This is the real-world layout; do not open the
      Content folder directly except where a step says to.
- [ ] UEFN stays open the whole session (it is the diagnostics source).
- [ ] Sync fixtures: `powershell -File test-fixtures/uefn-smoke/sync.ps1
      -ContentPath "$env:USERPROFILE\Documents\Fortnite Projects\VerseAutoImports\Content"`
- [ ] Open both output channels: "Verse Auto Imports" and "Verse Auto
      Imports - Debug".

## Phase C: test cases

### T0 -- environment sanity (multi-root workspace)

1. [ ] Status bar item appears; extension activates on opening a .verse file.
2. [ ] Debug channel shows the project detected as
       `/vukefn@fortnite.com/VerseAutoImports` (from .uefnproject found in the
       parent of Content).
3. [ ] Run "Verse Auto Imports: Rebuild Project Path Cache". Debug log file
       count must correspond to Content fixtures only -- if it reports
       scanning hundreds of files or mentions digest folders (/Verse.org
       etc.), the scan is leaking into other workspace roots. Record the
       count.
4. [ ] Open `Fortnite.digest.verse` from the /Fortnite.com root: no CodeLens
       spam, no auto-import activity triggered by it.

### T1 -- auto-import, single suggestion (fixture: Scripts/T1_auto_import.verse)

1. [ ] Open the file, confirm compile errors appear for creative_device,
       button_device, vector3, player.
2. [ ] Wait out the debounce (3s idle). Expected inserts, exactly once each:
       `using { /Fortnite.com/Devices }`, `using { /Verse.org/SpatialMath }`,
       `using { /Verse.org/Simulation }`.
3. [ ] Record the exact compiler error text for one identifier (drift check
       for extractor patterns).
4. [ ] File compiles clean afterwards.

### T2 -- multi-option (fixture: Scripts/T2_multi_option.verse + T2A/ + T2B/)

1. [ ] Error on `t2_shared_thing` appears; record exact message text.
2. [ ] No auto-import fires (default multiOptionStrategy).
3. [ ] Quick fix menu offers BOTH candidates (T2A and T2B variants), one
       action each.
4. [ ] Applying one resolves the error; applied import is syntactically valid.

### T3 -- asset references + digest watcher (fixture: Scripts/T3_assets.verse)

1. [ ] Errors for `image2`/`image3` (and `texture`): record exact message
       text including any "Did you mean ..." suggestion.
2. [ ] Whatever the extension does (auto-import or quick fix), the resulting
       import must NOT embed the asset name (`using { Folder1.image2 }` =
       FAIL; `using { Folder1 }` or no action = acceptable).
3. [ ] After Phase A, uncomment the material probe block and repeat for the
       material class -- this is the code path AssetsDigestParser was built
       for.
4. [ ] Watcher (#43): with VS Code open, rename any texture in UEFN (or add
       one) so Assets.digest.verse regenerates. Expected within seconds in
       the Debug channel: "Assets.digest.verse changed" + cache clear, WITHOUT
       reloading VS Code and without waiting for a TTL expiry.
5. [ ] Secondary (single-root mode): open ONLY the Content folder in VS Code
       (not the workspace file) and repeat step 4 -- this is the case the
       RelativePattern fix in #43 specifically targets (digest lives outside
       the workspace).

### T4 -- path conversion (fixture: Scripts/T4_path_conversion.verse + support folders)

1. [ ] Case A `Gadgets.Tools`: CodeLens offers conversion; result is
       `using { /vukefn@fortnite.com/VerseAutoImports/Gadgets/Tools }`.
2. [ ] Case B `Combat.Weapons` (exists under Systems/ AND Features/): KNOWN
       LIMITATION (#60, preexisting in 0.6.4) - resolves 0 locations. Expect a
       graceful "module not found" outcome, never a silently wrong path. The
       ambiguity feature itself is validated by Case C.
3. [ ] Case C `Economy.Shop` (explicit module declared in two files): both
       locations detected (Systems and Features). This exercises the cache
       lookup path and the #43 regex fix across multiple files.
4. [ ] Bulk command "Verse Auto Imports: Use Absolute Paths for All" handles
       all three lines coherently in one pass.
5. [ ] Cache off/on: set `cache.enabled` false, reload, repeat case C
       (pure filesystem path), then re-enable, rebuild cache, repeat again.
       Same results both ways; Debug log shows cache hits when enabled.
6. [ ] Persistence: reload the window with cache enabled; Debug log shows the
       cache loaded from storage rather than a cold rebuild.

### T5 -- Optimize Imports (fixture: Scripts/T5_optimize.verse)

1. [ ] With autoImport ON: run "Verse Auto Imports: Optimize Imports" once.
       All expected outcomes in the fixture header hold; specifically the
       missing SpatialMath import is added in the SAME single edit (no
       visible intermediate state where imports vanish), the local-scope
       `using { Helper }` is untouched, and one Ctrl+Z restores the original.
2. [ ] Re-sync the fixture, set general.autoImport OFF, repeat: identical end
       state.
3. [ ] Toast text matches what actually happened.

### T6 -- styles matrix (fixture: Scripts/T6_styles.verse)

1. [ ] importSyntax curly -> dot: optimize rewrites the block to `using.`
       style; flip back and it returns (idempotent on repeat runs).
2. [ ] importGrouping digestFirst: digest imports first, blank line, then
       `Gadgets.Tools`. localFirst reverses. none keeps flat.
3. [ ] sortImportsAlphabetically respected within groups.
4. [ ] behavior.emptyLinesAfterImports honored after each optimize.

### T7 -- cache commands and settings

1. [ ] "Verse Auto Imports: Rebuild Project Path Cache" and
       "Verse Auto Imports: Clear Project Path Cache" both exist in the
       palette and log sensible results.
2. [ ] Rebuild reports a plausible file/module count for the fixtures.
3. [ ] Toggle the three cache.* settings; no errors on flip; behavior follows
       (see T4.5).

### T8 -- status bar and snooze (#43)

1. [ ] Status bar menu opens; toggles reflect current settings.
2. [ ] Snooze auto-imports; invoke snooze AGAIN from the command palette
       while already snoozing; countdown stays coherent (single timer), and
       cancel/expiry restores the normal state. Watch Debug channel for
       duplicate-interval evidence.
3. [ ] Disable then re-enable auto-imports mid-snooze: snooze cancels
       automatically on the re-enable. The snooze itself never flips the
       setting, so before you touch it the Auto Import row reads
       "Snoozed (M:SS)" with its checkbox still ticked.
4. [ ] #132: snooze, then reload the window inside the 5 minutes. Auto-import
       must work again immediately, and settings.json must hold no
       verseAutoImports.general.autoImport entry.
5. [ ] #132: trigger a diagnostic and snooze within the debounce window
       (general.autoImportDebounceDelay, 3s by default) before the import
       lands. Nothing is imported.

### T9 -- book-construct validation (fixtures: T9/) [gates #65 and #71]

Each case checks whether live UEFN accepts a construct documented in the Book
of Verse; the results decide the fix design for #65 (relative import
classification) and #71 (import aliases), and give live regression coverage
for #67/#68. For every case record the verbatim outcome (clean compile, or
the exact diagnostic) with "Verse Auto Imports: Capture Diagnostics Corpus",
then fold new message shapes into
test-fixtures/corpus/<UEFN version>/diagnostics.json with expectations filled
in (see test-fixtures/corpus/README.md).

1. [ ] Case A bare same-directory import: in t9_relative_imports.verse,
       uncomment `using { Sub }` (plus the probe line). Compiles or exact
       error?
2. [ ] Case B subdirectory import: re-comment A, uncomment
       `using { Sub/Deep }`. Same question.
3. [ ] Case C sibling import: re-comment B, uncomment `using { ../Scripts }`.
       Same question.
4. [ ] Case D module-body using (t9_module_body.verse): file compiles as
       synced. Then remove the indented `/Verse.org/Simulation` pair, wait
       for the auto-import to re-add it, and confirm the module-scoped
       `using { /Verse.org/Random }` was not moved, deleted, or duplicated.
       Run "Verse Auto Imports: Optimize Imports" and save: same expectation
       (#67 live).
5. [ ] Case E indented style (same file): re-sync the fixture so the
       `using:` pair is back, then trigger any auto-import in the file (e.g.
       reference `button_device`). The pair must be consolidated into the
       import block with its path intact; no orphaned indented line (#68
       live).
6. [ ] Case F alias (t9_alias.verse): uncomment the import(...) lines.
       Compiles or exact error? If it compiles, add
       `using { /Verse.org/SpatialMath }` below and confirm the extension
       does not add duplicates or misbehave in the file (#71).
7. [ ] Capture: with all T9 files open and their diagnostics present, run
       "Verse Auto Imports: Capture Diagnostics Corpus" and curate the output
       into the corpus folder for this UEFN version.

## Phase D: verdict

| Case | Pass | Finding # |
|------|------|-----------|
| T0   |      |           |
| T1   |      |           |
| T2   |      |           |
| T3   |      |           |
| T4   |      |           |
| T5   |      |           |
| T6   |      |           |
| T7   |      |           |
| T8   |      |           |
| T9   |      |           |

Findings (number, verbatim evidence, suspected component):

1.

Exit criteria: every case passes, or every failure has a filed issue with a
decision (fix before release / ship as known issue). When a failure looks
preexisting rather than 0.7-introduced, install the Marketplace 0.6.4 build
and repeat the case to classify it.
