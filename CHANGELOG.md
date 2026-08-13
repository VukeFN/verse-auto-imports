# Changelog

All notable changes to the "Verse Auto Imports" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Where an entry resolves a tracked issue, it ends with a `[#N]` reference linked at the bottom of this file.

## [Unreleased]

Pending changes are kept as one file per change under [changelog.d/](changelog.d/) and assembled here at release.

## [0.11.1] - 2026-08-13

### Fixed

- **Project scan**: A Verse block macro written inside a function body is no longer recorded as a variable declaration, so keywords such as `block`, `loop` and `if` stop appearing as import and completion candidates ([#344])
- **Project scan**: a Verse block macro written with a parenthesised head, such as `if (Cond):` or `for (Item : Items):`, is no longer recorded as a function declaration or offered as an import candidate ([#350])
- **Project scan**: a line opening with a Verse block macro such as `array:`, `map:`, `assert:` or `let:` is no longer recorded as a declaration, so it stops appearing as an import candidate or completion entry ([#353])

## [0.11.0] - 2026-08-12

### Added

- **Module visibility**: a quick fix on the compiler's inaccessible-internal-module error declares the module `<public>`, editing an existing declaration where there is one and otherwise writing a definitions file at the Content root ([#61])

### Changed

- **Ambiguous import mappings**: `behavior.ambiguousImports` now defaults to no mappings, so a configured mapping is applied exactly as you set it ([#266])
- **Convert to relative path**: shortens an import against the module the file sits in, matching the spelling the Verse compiler suggests, instead of always against the project root ([#277])

### Fixed

- **Path conversion**: converting a relative import now finds a folder module anywhere in the project, not only beside the current file or at the Content root ([#60])
- **Path conversion**: A `using` naming a module alias the file declares with `import(...)` no longer gets a conversion lens, so converting paths singly or in bulk cannot rewrite it into an import of an unrelated namesake module ([#71])
- **Digest lookup**: An unknown identifier now resolves only to the entry with that exact name instead of every entry containing it, and unreadable bundled digest data reports an error instead of silently disabling lookups for the session ([#143])
- **Import scanning**: An indented `using:` import whose path sits below a blank line or a comment is now recognized, so the extension no longer adds a second copy of an import the file already has ([#145])
- **Organize Imports**: an import is no longer hoisted above the import pinned to its line that brings its first segment into scope, so organizing a file holding one leaves it compiling ([#232])
- **Auto import**: a newly added import is now written below an import that shares its line with another statement, instead of above it, so an import that needs that line's module in scope resolves where it lands ([#270])
- **Import sorting**: Sorting and adding imports now keep every relative `using` in its written order, since a dotted import can bring into scope the module a later bare import names ([#271])
- **Import scanning**: A `#` inside a string or char literal no longer ends the scan of its line, so a `using` written after one is seen and organize keeps an import it would otherwise remove ([#272])
- **Import scanning**: A `using` written after another statement on the same line now counts as already imported, and a `using` written inside a string is no longer read as one at all ([#273])
- **Import scanner**: A braced `using` written across several lines now counts as an import the file already makes, so a second copy of it is no longer added ([#274])
- **Path conversion**: the "Use absolute path" lens now resolves a module declared as `Name := module { ... }` or `Name := module. ...`, which previously failed with "Could not find module" ([#275])
- **Import quick fix**: a compiler message that offers both same-package names and `using` paths now lists every candidate, and Optimize Imports leaves it for you to choose ([#276])
- **Project scan**: a module declared as `Name := module { ... }`, with the brace on the next line, or as `Name := module. ...` now enters the project's declaration cache, so module lookups and quick fixes see it ([#282])
- **Import scanning**: A `using` written after a string that holds a `{ ... }` interpolation is no longer missed, so organize and cleanup no longer treat the import it names as absent ([#285])
- **Module visibility**: the quick fix now declines, and names the module standing in the way, when a `scoped`, `epic_internal`, `private` or `protected` module sits on the path to the one being made public ([#288])
- **Project scan**: A declaration commented out with a block comment, a `<#>` marker or a mid-line `#` is no longer recorded in the project declaration cache as live code ([#292])
- **Module visibility**: The quick fix now reports a module declared with a named access level instead of stacking a second specifier beside it, which the compiler rejects ([#293])
- **Import path conversion**: A module declared with a `scoped` list, `epic_internal`, or several stacked specifiers is now found by the fallback scan, so its path converts instead of being left unresolved ([#294])
- **Project scan**: a module declared `scoped{...}` or `epic_internal`, or one with padding inside its specifier brackets, is no longer offered as an import candidate that would not compile ([#305])
- **Import path conversion**: The fallback scan no longer treats a commented-out or string-quoted module declaration as a live one, so a conversion stops resolving to that file or asking which of two locations was meant ([#306])
- **Import scanning**: An indented `using:` pair opened after another statement on the same line now counts as already imported, so a suggested import is no longer added a second time ([#309])
- **Import placement**: a newly added import is written above an import held on its line only when the compiler reported the problem there, so it no longer lands above the import bringing its first segment into scope ([#313])
- **Auto import**: with import grouping set to digestFirst or localFirst, a newly added relative import is no longer written above a relative import the file already holds, and goes on its own line below instead ([#314])
- **Auto import**: with import locations not preserved, an existing import is no longer consolidated into the top block above a `using` pinned to its line that may bring its first segment into scope ([#315])
- **Project scan**: The declarations nested inside a module that cannot be imported are no longer offered as import candidates under a shortened path that does not compile ([#316])
- **Import scanner**: A `using:` pair whose opener comments out the path below it no longer counts that path as imported, so an import the file needs is written instead of declined ([#320])
- **Project scan**: A module whose body opens with a brace on the next line now nests its members, so their import paths carry the enclosing module and an unimportable one no longer offers its contents as top-level candidates ([#324])
- **Import placement**: a new import is no longer written between an indented `using:` and the path it opens, which left the file unable to compile ([#325])
- **Project scan**: A module whose braced body sits at or left of its own indent now nests its members, so their import paths keep the enclosing module and an unimportable one no longer offers its contents as top-level candidates ([#330])
- **Module visibility**: Making a module public now finds a declaration nested in a braced module whose body sits at or left of its own indent, editing that declaration instead of writing a second part beside it ([#333])
- **Project scan**: A module written inside a braced module body no longer holds that body open past its closing brace, so imports are no longer offered at paths one or more segments too long ([#336])
- **Project scan**: A module inside the braced body of a module dropped for its access level is no longer offered as a top-level import candidate at a path the compiler rejects ([#342])

## [0.10.0] - 2026-08-09

### Added

- **Debug logs**: the activation line and the exported log header now name the extension version, VS Code version, platform, workspace shape, and the settings that change import behavior ([#92])
- **Auto-import scope**: a new `general.autoImportScope` setting bounds which documents automatic imports may edit - `allFiles` (the default) keeps today's behavior, `openFiles` limits edits to open documents, `activeFile` to the active editor; quick fixes and CodeLens are unaffected ([#96])
- **Empty lines after imports**: setting `behavior.emptyLinesAfterImports` to -1 now leaves the spacing after your import block exactly as you wrote it, instead of normalizing it on every save, add and organize ([#151])

### Changed

- **Bundled Verse API digests**: refreshed to UEFN 41.30, adding the renamed AI conversation types, `prompt_binding_definition`, Fortnite character voices and 29 weapons and devices. The old `llm_*` and `*_prompt` names are gone; code using them needs updating ([#197])

### Removed

- **Settings**: `pathConversion.scanDepth` and `experimental.unknownIdentifierResolution` are gone; neither was ever consulted, and `experimental.useDigestFiles` already covers digest lookup ([#135])

### Fixed

- **Import edits**: a rejected edit now shows a warning instead of a success message, and **Optimize Imports** no longer saves the document when its edit did not apply ([#133])
- **Settings**: `cache.watcherDebounceMs` and `cache.autoRebuildOnStartup` now take effect; both were declared and documented but read by no code path ([#135])
- **Command palette**: five commands meant only for the quick fix and the CodeLens - Add Import, Use Absolute Path, Use Relative Path and the two convert-all commands - no longer appear in the palette, where running them raised an error ([#136])
- **Project path cache**: the cache being cleared or rebuilt while a saved file is being re-parsed no longer loses that update or leaves stale declarations in workspace storage for the next session ([#137])
- **Project path cache setting**: turning `cache.enableProjectCache` off now really disables the cache - the rebuild, clear and status commands report it as off, a stored cache is dropped, and toggling the setting offers the window reload it needs ([#138])
- **Header comments**: a file header comment now stays above the import block when imports are organized or a new import is added, and a comment directly above an import travels with it when the block is sorted ([#140])
- **Auto import and CodeLens**: a pending auto-import can no longer edit a file after the extension is disabled, the CodeLens provider stops handling keystrokes once it is gone, and a path conversion lens no longer vanishes under the cursor ([#142])
- **Saving no longer re-dirties the file**: the import spacing pass now runs as part of the save rather than editing the file once the save has finished, so the tab no longer shows unsaved changes the moment you press Ctrl+S ([#144])
- **Path conversion CodeLens**: a `using` inside a block comment or indented in a module body no longer gets a conversion lens or is touched by the convert-all commands, while a bare folder import now does ([#167])
- **Path conversion**: converting an import whose statement also appears elsewhere in the file, commented out above it say, now rewrites the line the CodeLens sits on rather than the first line reading the same ([#183])
- **Path conversion**: converting an import now warns when the edit could not be applied, and a whole-document conversion says how many imports it could not convert ([#185])
- **Import comments**: the comment trailing a `using` statement is no longer deleted when imports are sorted or organized, and an import line carrying a comment marker or an unclosed `<#` block opener is left where it was written ([#189])
- **Path conversion**: converting an import path keeps the comment trailing that line instead of deleting it or rewriting text inside it, in both directions and in both the braced and dotted styles ([#191])
- **Optimize Imports**: a file holding both a comment-anchored import and an ordinary import of the same path no longer keeps both - the ordinary one is removed, unless the file also imports a module by a bare or dotted name ([#192])
- **Import placement around an anchored import**: a new import is no longer written above the import that brings its first segment into scope when that import is anchored by a `<#` or `<#>` comment marker. Such an import belongs to no import block, so every placement decision was blind to it and the "Unknown identifier" the new import was added to resolve could survive ([#196])
- **Path conversion**: a brace inside the comment trailing an import no longer flips the `using` syntax style the conversion emits, which now follows the statement the author wrote ([#204])
- **Import paths read from the statement, not its comment**: a `using` import whose trailing comment mentioned another import in braces, such as `using. Economy.Shop # was using { Inventory }`, had that other path read as its own - converting the wrong module and misclassifying the import as a full path or a built-in one ([#207])
- **Optimize Imports**: a file holding both a comment-anchored import and an ordinary import of the same path no longer removes the ordinary one when two `using` statements share a line and something below still needs one of them ([#214])
- **Organize imports**: an indented `using:` pair written after a `;` on the same line no longer reads as absent, so organizing keeps an import the pair resolves against instead of dropping it ([#216])
- **Organize imports**: a `using:` pair opened after a `;` keeps both of its lines, instead of losing the opener and leaving its path stranded in the file body ([#219])
- **Optimize Imports**: a line writing two `using` statements keeps both, instead of being rebuilt from the first and silently dropping the second ([#223])
- **Import scanning**: A line writing three or more `using` statements and ending in a `using:` pair now counts every path it imports, so adding one of the middle paths no longer writes a second copy of it ([#233])
- **Organize imports**: A line that writes a definition after an import, such as `using { /X }; MyVal := 5`, is now left as written instead of losing the definition ([#235])
- **Import spacing**: `behavior.emptyLinesAfterImports` now takes whole numbers only, so a fractional value no longer stops the spacing after your imports settling on the count you configured. A value already saved rounds to the nearest whole number ([#242])
- **Import organizing**: a statement written after a dotted `using.` import on the same line is no longer folded into the import path, and the line is left exactly as written ([#244])
- **Import scanning**: A dotted import of a same-directory module sharing its line with another statement now counts as imported, so nothing writes a second copy of an import the file already makes ([#247])
- **Project path cache**: a .verse file that cannot be read when its change is processed keeps the declarations it already contributed, instead of dropping them until something edits the file again ([#255])

## [0.9.0] - 2026-08-06

### Changed

- **Command palette**: every command now appears under a **Verse Auto Imports** category instead of a `Verse: ` prefix, with command IDs unchanged so existing keybindings and tasks keep working ([#94])

### Fixed

- **Commented-out imports**: a `using` statement inside a `<# ... #>` block comment is now ignored by every import operation, so it is neither counted as already present nor hoisted back into force ([#127])
- **CRLF files**: editing imports in a file saved with Windows line endings no longer mixes CRLF and LF, and **Optimize Imports** no longer rewrites the whole document on every invocation ([#139])
- **Snooze Auto Import**: a snooze now ends with the window instead of leaving `general.autoImport: false` behind, and the status menu shows `Snoozed (M:SS)` while one is active. If an earlier snooze left auto import off, re-enable it once ([#132])
- **Asset names**: the extension now keeps recognizing asset class names after UEFN rewrites the digest, knows them when VS Code opens before UEFN has generated it, and follows a renamed project — no window reload needed ([#131])
- **"Did you mean" suggestions**: a suggestion is only turned into an import when it is a dotted chain of Verse identifiers, so trailing punctuation or prose no longer produces a wrong or syntactically invalid import ([#130])
- **Import placement**: an import added to a file whose imports sit in blank-line-separated groups now lands in the group the file's ordering calls for, rather than always the first ([#129])
- **Auto import**: two files sharing a name across module folders, such as `Weapons/utils.verse` and `UI/utils.verse`, are now imported independently instead of cancelling or skipping each other's pending import ([#134])
- **Project path cache**: a `.uefnproject` file created after the workspace was opened now re-engages the cache, instead of leaving module lookups on a full filesystem scan for the rest of the session ([#146])
- **Optimize Imports**: an import line that opens a `<#` block comment is now left where it is, so the lines it comments out stay commented out ([#166])

## [0.8.0] - 2026-08-04

### Added

- **Clear Project Path Cache**: a new command wipes both the in-memory cache and its persisted copy in workspace storage without rebuilding it, so the next lookup starts cold ([#93])

### Changed

- **Bundled Verse API digests**: refreshed to UEFN 41.10, so import suggestions reflect that API surface

### Fixed

- **Output log**: regenerating Epic's `Assets.digest.verse` no longer logs a `Failed to parse` error ([#95])
- **Import suggestions**: the bundled API digests now attribute each declaration to the correct module, so `button_device` and `trigger_device` resolve to the right path and `creative_device`, `agent`, `player` and `vector3` are importable at all ([#97])
- **Import grouping**: an out-of-enum `behavior.importGrouping` value now falls back to ungrouped output instead of removing every import from the file ([#121])
- **Trailing comments**: an import in dot syntax with a trailing comment, such as `using. /Verse.org/Simulation # note`, is no longer rewritten into a statement the comment breaks ([#120])

## [0.7.1] - 2026-08-02

### Fixed

- **Preserve import locations**: with grouping enabled, a quick fix on a file whose import block sits below a header comment now regroups that block in place instead of deleting it and rewriting the imports at the top ([#90])
- **Import sorting**: sorting no longer reorders a `using` block in a way that breaks compilation, and the quick fix merges new imports into the block in the same order — absolute paths, then bare local imports, then dotted ones ([#91])
- **Folder imports**: a file-level bare `using { X }` is now recognized as a module import, so deduplication and **Optimize Imports** no longer overlook an import the extension inserted itself ([#65])

## [0.7.0] - 2026-07-11

### Added

- **Project Path Caching**: the extension now caches your project's module structure so relative-to-absolute path conversion resolves faster, especially in large projects. Enabled by default. ([#41])
  - New setting `cache.enableProjectCache` (default: on) to toggle caching
  - New setting `cache.autoRebuildOnStartup` (default: off) to rebuild the cache when VS Code starts
  - New setting `cache.watcherDebounceMs` (default: 500) to tune how quickly file changes refresh the cache
  - New command **Verse: Rebuild Project Path Cache** to refresh the cache on demand
  - New command **Verse: Show Cache Status** to inspect the current cache state
- **Capture Diagnostics Corpus**: new command **Verse: Capture Diagnostics Corpus** exports the verbatim compiler diagnostics of open Verse files to JSON. Used to maintain the message-format regression corpus (`test-fixtures/corpus/`) that guards import extraction against wording changes between UEFN releases

### Changed

- **Faster Cache Rebuilds**: project files are scanned concurrently when rebuilding the path cache. The cache storage format changed; existing caches are rebuilt automatically on first use after updating. ([#41])
- **Quick Fix Titles Are Plain Text**: quick-fix menu entries no longer prefix titles with a checkmark symbol, and the confidence markers on multi-option import suggestions now read `[medium confidence]` / `[low confidence]` instead of emoji indicators
- **Assets Digest Cache Duration**: the cached list of project asset class names now refreshes every 5 minutes instead of every 30 seconds, matching the API digest cache. Asset changes are normally picked up immediately by the file watcher; the longer interval only applies as a fallback when a digest change is not observed by the watcher

### Fixed

- **Optimize Imports Diagnostic Parsing**: "Optimize Imports" no longer inserts a malformed import when the compiler suggests an assignment fix (for example `using { to write 'set Foo }`), and no longer adds every candidate module of an ambiguous "one of" error at once; ambiguous cases are left to the quick-fix menu ([#69])
- **Quick Fix Menu Noise**: "Did you mean any of" compiler suggestions no longer produce import options for bare identifiers (such as local definitions echoed in the option list), which generated invalid `using` statements when applied ([#70])
- **Path Conversion with Project Cache**: "Use Absolute Path" and related commands produced malformed import paths or wrong module suggestions when the project path cache was enabled (the default) ([#41])
  - Cache results now use the same location format as the filesystem scan instead of raw declaration paths
  - Module names are matched exactly: unrelated identifiers like `MyUtils` no longer match `Utils`, and class or struct names are never offered as module locations
  - Cached results are validated against the filesystem before use, with automatic fallback to a full scan when the cache is stale
  - The search near the current file runs first again, so the nearest module is preferred over project-wide matches
- **Optimize Imports Reliability**: with auto-import enabled (the default), "Optimize Imports" could momentarily strip every import, report success, and leave the file unorganized while the imports reappeared a moment later. The command now organizes imports in a single step and never leaves the file without them; behavior no longer depends on the auto-import debounce delay ([#42])
- **Auto-Import Asset Class Names**: automatic imports now exclude asset class names from the import path, matching the quick-fix behavior. Previously the automatic path could import `using { A.B.ClassName }` where the quick fix correctly used `using { A.B }` ([#43])
- **Indented Imports No Longer Corrupted**: adding an import to a file that uses the indented style (`using:` with the path on the next line) no longer deletes the `using:` line while leaving the path line orphaned, which lost the existing import and broke compilation ([#68])
- **Module-Scoped Imports Left in Place**: a `using` statement inside a module body is no longer moved to the top of the file by auto-import or "Optimize Imports", and saving no longer inserts blank lines after it in the middle of the module ([#67])
- **Asset Changes Detected Promptly**: adding or renaming assets in UEFN is now picked up as soon as the assets digest regenerates, instead of after a delay. The file watcher for the out-of-workspace assets digest was not firing ([#43])
- **Ambiguous Module Detection**: when a module is defined in several files, path conversion no longer drops valid locations depending on the order files are scanned ([#43])
- **Snooze Timer**: repeatedly starting snooze from the command palette no longer leaves extra countdown timers running, and an active snooze is cleaned up when the extension is disabled or reloaded ([#43])
- **Diagnostics Noise in UEFN Workspaces**: the auto-import listener no longer tries to open VS Code internal documents (which logged an error on every edit preview) and no longer reprocesses Epic's read-only `*.digest.verse` files, which carry permanent compiler errors in the standard UEFN workspace, on every diagnostics update ([#46])
- **Path Conversion Scan Scope**: the fallback scan for explicit module declarations no longer reads Epic's digest files on every lookup in the standard UEFN multi-root workspace; it is now scoped to the project folder
- **Debounce Delay Setting Restored**: `general.autoImportDebounceDelay` now actually controls the auto-import debounce. The deprecated `general.diagnosticDelay` setting's registered default (1000ms) silently overrode it, so the intended 3000ms default never applied and changing the new setting had no effect. An explicitly set `diagnosticDelay` is still honored when the new setting is left unset ([#76])
- **Status Bar Menu Error Feedback**: when a status bar menu action fails (for example, a settings update is rejected), the error is now shown as a notification and written to the extension log instead of failing silently
- **Digest Suggestions Survive Broken Bundled Data**: when none of the extension's bundled pre-compiled digest files can be loaded (for example after a corrupted install), import suggestions now fall back to parsing digest files at runtime instead of silently operating with an empty digest index, which previously left digest-based suggestions returning no results
- **Ambiguous Import Mappings Reconnected**: the `behavior.ambiguousImports` setting (and its shipped `vector3`/`vector2`/`rotation` defaults) is applied again. The code read a stale pre-0.6.0 configuration key, so configured mappings never took effect and every activation logged a settings write error. Mappings stored under the pre-0.6.0 `verseAutoImports.ambiguousImports` key must be moved to `verseAutoImports.behavior.ambiguousImports` ([#77])
- **Asset Class Names Parsed on UEFN 41.10**: asset class detection recognizes the 41.10 `Assets.digest.verse` format again. The parser only matched `Name<public|internal|private> := class`, so the 41.10 shapes (specifiers carrying `{...}` arguments such as `<scoped {...}>`, stacked specifiers including on the `class` keyword like `class<final><scoped {...}>`, `protected`, and `name<...>:type = external {}` instance declarations) parsed to zero names and silently disabled the asset-class-boundary feature. All of these shapes are now recognized, while the older formats still parse and indented class members are no longer mistaken for asset names ([#63])

## [0.6.4] - 2026-02-14

### Fixed

- **Indented Using Detection**: `using:` followed by an indented bare identifier (local-scope) was incorrectly treated as a module import. Now uses content-based detection across all three Verse syntactic styles (braced, dotted, indented)

## [0.6.3] - 2026-02-14

### Fixed

- **Local-Scope Using Conflicts**: Local-scope `using` statements (e.g., `using{Variable}`) inside function bodies were incorrectly treated as module imports, causing them to be grouped with actual imports, deleted during import optimization, or shown in CodeLens path conversion ([#23])

## [0.6.2] - 2026-02-05

### Fixed

- **Asset Class Name Detection**: Fixed incorrect import suggestions when using project assets
  - Previously, errors like "Did you mean Ake.UI.UI_UMG.ClassName" would incorrectly suggest `using { Ake.UI.UI_UMG }` (including the class name in the import)
  - Now correctly suggests `using { Ake.UI }` by parsing the project's `Assets.digest.verse` file to identify class names
  - Automatically detects asset class names from `Assets.digest.verse` located in your UEFN VerseProject folder
  - File watcher automatically refreshes class name cache when `Assets.digest.verse` changes

## [0.6.1] - 2025-12-01

### Fixed

- **Old UEFN Project Structure Support**: Fixed `.uefnproject` file detection for legacy UEFN projects where the Content folder is nested under `Plugins/<ProjectName>/Content`
  - Now searches up to 5 parent directories to find the project file
  - Supports both old structure (`Plugins/<ProjectName>/Content`) and new structure (`Content` directly under project root)

## [0.6.0] - 2025-11-30

### Added

- **Organized Status Bar Menu**: Menu items are now grouped into logical categories with labeled separators:
  - Quick Actions, General, Import Behavior, Path Conversion, Experimental, Utilities
- **CodeLens Visibility Submenu**: Access CodeLens visibility settings directly from the status bar menu
- **Configurable Empty Lines After Imports**: Control spacing between imports and code
  - New `behavior.emptyLinesAfterImports` setting (0-5 lines, default: 1)
  - Automatically applied when saving files, adding new imports, or running "Optimize Imports"
  - Maintains consistent code formatting across your project
- **Import Grouping**: Separate digest imports from local imports for better organization
  - New `behavior.importGrouping` setting with three options:
    - `"none"` - No grouping (default, maintains backward compatibility)
    - `"digestFirst"` - Groups digest imports (/Verse.org/, /Fortnite.com/, /UnrealEngine.com/) first, then local imports
    - `"localFirst"` - Groups local imports first, then digest imports
  - Automatic blank line separator between groups for visual clarity
  - Works with both "Optimize Imports" command and auto-import
  - Respects `sortImportsAlphabetically` setting within each group
  - Toggle option available in status bar menu
- **Configurable Digest Import Prefixes**: Customize which path prefixes are recognized as digest (API) imports
  - New `behavior.digestImportPrefixes` setting
  - Default: `["/Verse.org/", "/Fortnite.com/", "/UnrealEngine.com/"]`
  - Add new prefixes if Epic introduces additional API domains without waiting for an extension update
- **Smart Auto-Import Debouncing**: Auto-imports now wait for you to stop typing before triggering
  - Prevents distracting imports while actively coding
  - Configurable delay (default 3 seconds)
  - Properly cancels pending imports when you continue typing
  - Each keystroke resets the timer for a smoother coding experience
- **Enhanced Logging System**: Improved debugging with multi-level logging
  - Six log levels: TRACE, DEBUG, INFO, WARN, ERROR, FATAL
  - Dual output channels:
    - "Verse Auto Imports" - User-facing channel showing INFO+ messages
    - "Verse Auto Imports - Debug" - Debug channel showing all log levels
  - **Export Debug Logs**: Export debug logs to a file for sharing or analysis
    - Access via Status Bar menu → Utilities → Export Debug Logs
    - Choose save location with native file dialog
    - Logs up to 10,000 entries in memory
  - Performance tracking with built-in timers for slow operations
  - Structured logging with module context and error stack traces
  - No configuration needed - works out of the box
- **Full Path Import Conversion**: Added CodeLens support to convert relative imports to full path format
- **CodeLens Visibility Options**: Configure when path conversion CodeLens appears
  - `pathConversion.codeLensVisibility`: Choose between `"hover"` (default) or `"always"` visible
  - `pathConversion.codeLensHideDelay`: Customize how long CodeLens stays visible after leaving hover (default: 1 second)
- **Project Path Detection**: Automatically detects project Verse path from .uefnproject files
- **Ambiguous Module Handling**: Smart detection and resolution when modules exist in multiple locations
- **Batch Conversion**: Convert all imports to full paths with a single command
- **Configuration Reorganization**: Settings now organized into logical sections for better discoverability
  - `General`: Core functionality (auto-import, diagnostic delay)
  - `Import Behavior`: Import handling (syntax, locations, multi-option strategy)
  - `Quick Fix`: Quick fix menu customization (ordering, descriptions)
  - `Path Conversion`: Absolute/relative path conversion settings
  - `Experimental`: Experimental features (digest files)
- **Path Conversion Toggle**: New setting to enable/disable the path conversion helper
  - Toggle via Status Bar menu, Settings UI, or Command Palette
  - Command: `Verse: Toggle Path Conversion Helper`
- New `general.autoImportDebounceDelay` setting (default: 3000ms)
- Configuration options for CodeLens visibility and module scan depth
- Buy Me a Coffee donation option

### Changed

- **Updated CodeLens Icons**: Path conversion actions now use clearer icons (`$(arrow-both)` for single, `$(arrow-swap)` for bulk) instead of thin arrows for better visibility
- Default for `preserveImportLocations` changed to `true` (was `false`) - now preserves import locations by default
- Default for `showDescriptions` changed to `false` (was `true`) - cleaner quick fix menu by default
- Deprecated `general.diagnosticDelay` in favor of the new clearer naming `autoImportDebounceDelay`
- **Instant CodeLens Updates**: Path conversion actions now update immediately (no more 1-second delay)
- **Theme-Aware Status Bar**: Status bar tooltip now uses VS Code theme colors
  - Automatically adapts to Light, Dark, and High Contrast themes
  - Native button appearance without unsupported CSS properties

### Configuration Changes

Settings have been reorganized with new names (old settings will need to be updated):

- `autoImport` → `general.autoImport`
- `diagnosticDelay` → `general.diagnosticDelay`
- `importSyntax` → `behavior.importSyntax`
- `preserveImportLocations` → `behavior.preserveImportLocations`
- `ambiguousImports` → `behavior.ambiguousImports`
- `multiOptionStrategy` → `behavior.multiOptionStrategy`
- `quickFixOrdering` → `quickFix.ordering`
- `showQuickFixDescriptions` → `quickFix.showDescriptions`
- `showFullPathCodeLens` → `pathConversion.enableCodeLens`
- `fullPathScanDepth` → `pathConversion.scanDepth`
- `useDigestFiles` → `experimental.useDigestFiles`
- `unknownIdentifierResolution` → `experimental.unknownIdentifierResolution`

### Improved

- **Code Architecture Refactoring**: Reorganized codebase for better maintainability
  - Feature-based folder structure (imports/, diagnostics/, commands/, ui/, project/, services/)
  - Barrel files (index.ts) for cleaner imports throughout the codebase
  - Split ImportHandler into focused single-purpose classes (ImportFormatter, ImportSuggestionExtractor, ImportDocumentEditor)
- **Smart Snooze Cancellation**: Snooze is now automatically cancelled when auto imports are manually enabled mid-snooze, keeping the UI state consistent with user intent
- **Faster CodeLens Updates**: Optimized CodeLens refresh performance by eliminating redundant refresh calls
- Better Timer Management: Enhanced diagnostic handler with proper debouncing mechanism
- Enhanced Error Detection: Improved handling of "Unknown identifier" errors that include specific import suggestions
- Backward Compatibility: Legacy `diagnosticDelay` setting still works while transitioning to new `autoImportDebounceDelay`
- Enhanced import path resolution with workspace-aware scanning
- Better support for UEFN project structure (Content folder detection)

### Fixed

- Path normalization in import path converter for better handling of forward/backward slashes
- Properly removes trailing slashes after stripping module paths
- Module path conversion now works correctly when workspace folder IS the Content folder (not just containing it)
- Shows clear error notification when module cannot be found instead of silently producing incorrect paths

### Documentation

- Updated all configuration examples with new setting names
- Improved README organization with sectioned settings tables

## [0.5.3] - 2024-10-04

### Fixed

- Ignore ambiguous data errors suggesting 'set' syntax

## [0.5.2] - 2024-09-30

### Fixed

- Added support for "Identifier X could be one of many types" error pattern format

## [0.5.1] - 2024-09-30

### Fixed

- Added support for "Did you forget to specify one of" error pattern format

## [0.5.0] - 2024-09-15

### Added

- **Multi-Option Quick Fixes**: When VS Code shows "Did you mean any of", you now get separate import options for each possibility
- **Enhanced Error Recognition**: Improved pattern matching for various Verse compiler error formats
- **Advanced Configuration**: New settings for fine-tuning extension behavior
- **Better Import Organization**: Proper spacing and consolidation when moving imports to top
- **Experimental Digest Integration**: Optional API-based suggestions (disabled by default)

### Improved

- Fixed multi-option parsing to extract correct namespaces
- Disabled experimental features by default for better stability
- Enhanced quick fix menu with confidence indicators and descriptions
- Better handling of edge cases in import organization

## [0.4.4] - 2024-05-15

### Fixed

- Fixed detection of custom namespace patterns
- Disabled module visibility management features
- Improved error handling and diagnostics

## [0.4.3] - 2024-04-04

### Fixed

- Fixed outdated error message pattern detection

## [0.4.2] - 2024-03-15

### Added

- `preserveImportLocations` setting

### Improved

- Fixed code deletion between scattered import statements
- Improved import block handling

## [0.4.1] - 2024-03-14

### Added

- Configurable import syntax (`using { }` vs `using.`)
- Diagnostic processing delay for better performance
- Quick fix support for manual import management
- Ambiguous import handling
- Improved logging and error handling

## Earlier Versions

See [GitHub Releases](https://github.com/VukeFN/verse-auto-imports/releases) for complete changelog of earlier versions.

<!-- Version comparisons. The chain starts at 0.6.0: no v0.4.x or v0.5.x tags exist. -->

[Unreleased]: https://github.com/vukefn/verse-auto-imports/compare/v0.11.1...HEAD
[0.11.1]: https://github.com/vukefn/verse-auto-imports/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/vukefn/verse-auto-imports/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/vukefn/verse-auto-imports/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/vukefn/verse-auto-imports/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/VukeFN/verse-auto-imports/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/VukeFN/verse-auto-imports/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/VukeFN/verse-auto-imports/releases/tag/v0.6.0

<!-- Issue references -->

[#344]: https://github.com/vukefn/verse-auto-imports/issues/344
[#350]: https://github.com/vukefn/verse-auto-imports/issues/350
[#353]: https://github.com/vukefn/verse-auto-imports/issues/353
[#60]: https://github.com/vukefn/verse-auto-imports/issues/60
[#61]: https://github.com/vukefn/verse-auto-imports/issues/61
[#71]: https://github.com/vukefn/verse-auto-imports/issues/71
[#143]: https://github.com/vukefn/verse-auto-imports/issues/143
[#145]: https://github.com/vukefn/verse-auto-imports/issues/145
[#232]: https://github.com/vukefn/verse-auto-imports/issues/232
[#266]: https://github.com/vukefn/verse-auto-imports/issues/266
[#270]: https://github.com/vukefn/verse-auto-imports/issues/270
[#271]: https://github.com/vukefn/verse-auto-imports/issues/271
[#272]: https://github.com/vukefn/verse-auto-imports/issues/272
[#273]: https://github.com/vukefn/verse-auto-imports/issues/273
[#274]: https://github.com/vukefn/verse-auto-imports/issues/274
[#275]: https://github.com/vukefn/verse-auto-imports/issues/275
[#276]: https://github.com/vukefn/verse-auto-imports/issues/276
[#277]: https://github.com/vukefn/verse-auto-imports/issues/277
[#282]: https://github.com/vukefn/verse-auto-imports/issues/282
[#285]: https://github.com/vukefn/verse-auto-imports/issues/285
[#288]: https://github.com/vukefn/verse-auto-imports/issues/288
[#292]: https://github.com/vukefn/verse-auto-imports/issues/292
[#293]: https://github.com/vukefn/verse-auto-imports/issues/293
[#294]: https://github.com/vukefn/verse-auto-imports/issues/294
[#305]: https://github.com/vukefn/verse-auto-imports/issues/305
[#306]: https://github.com/vukefn/verse-auto-imports/issues/306
[#309]: https://github.com/vukefn/verse-auto-imports/issues/309
[#313]: https://github.com/vukefn/verse-auto-imports/issues/313
[#314]: https://github.com/vukefn/verse-auto-imports/issues/314
[#315]: https://github.com/vukefn/verse-auto-imports/issues/315
[#316]: https://github.com/vukefn/verse-auto-imports/issues/316
[#320]: https://github.com/vukefn/verse-auto-imports/issues/320
[#324]: https://github.com/vukefn/verse-auto-imports/issues/324
[#325]: https://github.com/vukefn/verse-auto-imports/issues/325
[#330]: https://github.com/vukefn/verse-auto-imports/issues/330
[#333]: https://github.com/vukefn/verse-auto-imports/issues/333
[#336]: https://github.com/vukefn/verse-auto-imports/issues/336
[#342]: https://github.com/vukefn/verse-auto-imports/issues/342
[#92]: https://github.com/vukefn/verse-auto-imports/issues/92
[#96]: https://github.com/vukefn/verse-auto-imports/issues/96
[#133]: https://github.com/vukefn/verse-auto-imports/issues/133
[#135]: https://github.com/vukefn/verse-auto-imports/issues/135
[#135]: https://github.com/vukefn/verse-auto-imports/issues/135
[#136]: https://github.com/vukefn/verse-auto-imports/issues/136
[#137]: https://github.com/vukefn/verse-auto-imports/issues/137
[#138]: https://github.com/vukefn/verse-auto-imports/issues/138
[#140]: https://github.com/vukefn/verse-auto-imports/issues/140
[#142]: https://github.com/vukefn/verse-auto-imports/issues/142
[#144]: https://github.com/vukefn/verse-auto-imports/issues/144
[#151]: https://github.com/vukefn/verse-auto-imports/issues/151
[#167]: https://github.com/vukefn/verse-auto-imports/issues/167
[#183]: https://github.com/vukefn/verse-auto-imports/issues/183
[#185]: https://github.com/vukefn/verse-auto-imports/issues/185
[#189]: https://github.com/vukefn/verse-auto-imports/issues/189
[#191]: https://github.com/vukefn/verse-auto-imports/issues/191
[#192]: https://github.com/vukefn/verse-auto-imports/issues/192
[#196]: https://github.com/vukefn/verse-auto-imports/issues/196
[#197]: https://github.com/vukefn/verse-auto-imports/issues/197
[#204]: https://github.com/vukefn/verse-auto-imports/issues/204
[#207]: https://github.com/vukefn/verse-auto-imports/issues/207
[#214]: https://github.com/vukefn/verse-auto-imports/issues/214
[#216]: https://github.com/vukefn/verse-auto-imports/issues/216
[#219]: https://github.com/vukefn/verse-auto-imports/issues/219
[#223]: https://github.com/vukefn/verse-auto-imports/issues/223
[#233]: https://github.com/vukefn/verse-auto-imports/issues/233
[#235]: https://github.com/vukefn/verse-auto-imports/issues/235
[#242]: https://github.com/vukefn/verse-auto-imports/issues/242
[#244]: https://github.com/vukefn/verse-auto-imports/issues/244
[#247]: https://github.com/vukefn/verse-auto-imports/issues/247
[#255]: https://github.com/vukefn/verse-auto-imports/issues/255
[#129]: https://github.com/vukefn/verse-auto-imports/issues/129
[#134]: https://github.com/vukefn/verse-auto-imports/issues/134
[#146]: https://github.com/vukefn/verse-auto-imports/issues/146
[#166]: https://github.com/vukefn/verse-auto-imports/issues/166
[#23]: https://github.com/VukeFN/verse-auto-imports/issues/23
[#41]: https://github.com/VukeFN/verse-auto-imports/issues/41
[#42]: https://github.com/VukeFN/verse-auto-imports/issues/42
[#43]: https://github.com/VukeFN/verse-auto-imports/issues/43
[#46]: https://github.com/VukeFN/verse-auto-imports/issues/46
[#63]: https://github.com/VukeFN/verse-auto-imports/issues/63
[#65]: https://github.com/VukeFN/verse-auto-imports/issues/65
[#67]: https://github.com/VukeFN/verse-auto-imports/issues/67
[#68]: https://github.com/VukeFN/verse-auto-imports/issues/68
[#69]: https://github.com/VukeFN/verse-auto-imports/issues/69
[#70]: https://github.com/VukeFN/verse-auto-imports/issues/70
[#76]: https://github.com/VukeFN/verse-auto-imports/issues/76
[#77]: https://github.com/VukeFN/verse-auto-imports/issues/77
[#90]: https://github.com/VukeFN/verse-auto-imports/issues/90
[#91]: https://github.com/VukeFN/verse-auto-imports/issues/91
[#93]: https://github.com/VukeFN/verse-auto-imports/issues/93
[#94]: https://github.com/VukeFN/verse-auto-imports/issues/94
[#95]: https://github.com/VukeFN/verse-auto-imports/issues/95
[#97]: https://github.com/VukeFN/verse-auto-imports/issues/97
[#120]: https://github.com/VukeFN/verse-auto-imports/issues/120
[#121]: https://github.com/VukeFN/verse-auto-imports/issues/121
[#127]: https://github.com/VukeFN/verse-auto-imports/issues/127
[#130]: https://github.com/VukeFN/verse-auto-imports/issues/130
[#131]: https://github.com/VukeFN/verse-auto-imports/issues/131
[#132]: https://github.com/VukeFN/verse-auto-imports/issues/132
[#139]: https://github.com/VukeFN/verse-auto-imports/issues/139
