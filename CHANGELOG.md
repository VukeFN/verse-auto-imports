# Changelog

All notable changes to the "Verse Auto Imports" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Where an entry resolves a tracked issue, it ends with a `[#N]` reference linked at the bottom of this file.

## [Unreleased]

### Added

- **Clear Project Path Cache**: new command **Verse: Clear Project Path Cache** wipes both the in-memory cache and its persisted copy in workspace storage without rebuilding it, so the next lookup starts cold. Useful for recovering from a corrupt cache or testing cold-start behavior; ordinary rebuilds remain available via **Verse: Rebuild Project Path Cache** ([#93])

### Changed

- **Bundled Digests Refreshed to 41.10**: the pre-compiled API digests (`Fortnite`, `UnrealEngine`, `Verse`) were regenerated from `++Fortnite+Release-41.10-CL-55335788`, so import suggestions reflect the current UEFN API surface

### Fixed

- **Digest Files No Longer Logged as Scanner Errors**: regenerating Epic's `Assets.digest.verse` no longer logs a `Failed to parse ... Content\Assets.digest.verse` error. The project path cache's file watcher reaches the out-of-workspace digest in the UEFN multi-root workspace; it now ignores every `*.digest.verse` change, create, and delete event, since digest files are generated API surface and never project declarations. The declaration cache was otherwise unaffected ([#95])
- **Digest Module Paths Resolved Correctly**: the bundled API digest parser now attributes each declaration to the correct module. It previously tracked `# Module import path:` comments as ambient state with no indentation model, so a comment leaked onto later comment-less modules — `button_device` and `trigger_device` resolved to `/Fortnite.com/AI/movement_types` instead of `/Fortnite.com/Devices`. It also required `<public>` to appear immediately after the identifier, so `<native><public>` declarations were dropped entirely, leaving `creative_device`, `agent`, `player`, and `vector3` unimportable and producing no `/Fortnite.com/Devices` entry in the module index. Module scope is now derived from indentation (like the assets digest parser): a pending import-path comment applies to the next module only, then resolution falls back to a `(/path:)` scope qualifier, the enclosing module, or the file's root domain, and specifier order no longer affects which declarations are recognized ([#97])

## [0.7.1] - 2026-08-02

### Fixed

- **Preserve Import Locations With Grouping**: with `behavior.preserveImportLocations` enabled (the default) and `behavior.importGrouping` set to `digestFirst` or `localFirst`, applying a quick fix to a file whose single import block sits below a header comment no longer deletes that block and rewrites the imports at the top of the file. The block is now regrouped in place at its original location ([#90])
- **Import Sorting Respects Verse Resolution Order**: with `behavior.sortImportsAlphabetically` enabled (the default), sorting no longer reorders a `using` block in a way that breaks compilation. Because Verse resolves `using` statements top-down, a dotted local import such as `using { Economy.Shop }` needs its first segment (`Economy`) already in scope, which a bare local import like `using { Features }` provides. Plain alphabetical sorting placed `Economy.Shop` before `Features` and reintroduced the original "Unknown identifier" error. Sorting now uses rank-based ordering: absolute paths first (alphabetical), then bare local imports, then dotted local imports (alphabetical). Bare local imports now precede dotted ones and keep their original relative order, because import order is semantic in Verse — a nested child must follow the parent that provides it. When sorting is enabled (the default config included), the quick fix now merges new imports into the existing import block in this rank order rather than appending them below it, so a new provider import can no longer land beneath a consumer that depends on it. When sorting is disabled, order is left untouched as before ([#91])
- **Same-Directory Folder Imports Recognized**: a file-level bare `using { X }` (a same-directory folder-module import) is now recognized as a module import. Previously every bare `using { X }` was treated as a local-scope using, so such imports were invisible to deduplication and "Optimize Imports", and the extension did not recognize an import it had itself inserted. A bare `using` at the top of a `.verse` file can only be a module import, since local-scope `using` is legal only inside a function body. These imports keep their original relative order among themselves, because import order is semantic in Verse — a nested child must follow the parent that provides it ([#65])

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

[Unreleased]: https://github.com/VukeFN/verse-auto-imports/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/VukeFN/verse-auto-imports/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/VukeFN/verse-auto-imports/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/VukeFN/verse-auto-imports/releases/tag/v0.6.0

<!-- Issue references -->

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
<<<<<<< HEAD
<<<<<<< HEAD
[#95]: https://github.com/VukeFN/verse-auto-imports/issues/95
=======
[#93]: https://github.com/VukeFN/verse-auto-imports/issues/93
>>>>>>> 1781c84 (feat(cache): add Clear Project Path Cache command)
=======
[#97]: https://github.com/VukeFN/verse-auto-imports/issues/97
>>>>>>> c160e71 (chore(digest): refresh bundled digests to 41.10 and regenerate data)
