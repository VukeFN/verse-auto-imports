# Decisions

Choices this project has made on purpose, and does not want raised again.

A review that reaches one of these should stop. If the reasoning below no longer holds, that is worth a ticket — say what changed. If it still holds, there is nothing to file.

Each entry records the decision, why it holds, and what would make it wrong. The last part matters most: a decision with no expiry condition is a habit, not a decision.

## Keep the `engines.vscode` floor at ^1.85.0

Raising the floor drops every user on an editor below it, because the Marketplace serves them the last compatible version instead. The lane A review checked every VS Code API this extension uses: the newest is 1.67-era (`window.tabGroups`, `TabInputText`). Raising the floor today buys zero capability.

**Revisit when** a wanted API postdates 1.85. Then the trade is real and worth pricing.

Note that the floor is currently a promise no tool enforces, because `@types/vscode` is declared with a caret and floats far above it. That is a defect, not a decision, and it has its own ticket.

## Keep snooze state in memory

Snooze is ephemeral and time-boxed, so it does not survive a window reload. The worst case is that auto-import resumes up to five minutes early. That is benign, self-correcting, and one click to redo, against roughly 30 lines and a new class of persisted state with its own failure modes.

This is a decision with history. Snooze once wrote `general.autoImport: false` into global settings and relied on an interval to write it back; a reload mid-snooze left auto-import off permanently. The fix moved the state into memory.

**Revisit when** snooze durations grow long enough that losing one is expensive, or the state stops being purely time-boxed.

The comment at `StatusBarHandler.ts:65-69` currently defends this too broadly. It says persisting snooze "could leave auto imports off forever", which is true of a persisted flag and false of a persisted end-timestamp that expires by wall clock. The comment needs narrowing to the case it actually argues against; that is part of the dead-state cleanup ticket.

## Keep the status bar item for the life of the window

The item appears only after a Verse file activates the extension, so it never shows in windows that never touch Verse. Inside a Verse session it is the snooze surface and the only discoverable route to the menu. Hiding it when the active editor is not Verse costs a show-and-hide state machine, and makes a running snooze countdown disappear while it is still counting.

**Revisit when** the status bar item stops being the primary entry point, or a user reports the footprint as a problem.

## Do not localize yet

There is no `package.nls.json` and no use of `vscode.l10n`. The user-facing surface is 102 strings in code plus 20 command titles and 22 setting descriptions in the manifest. Localizing is mechanical but touches all of it, and no evidence exists yet that the audience needs it.

**Revisit when** a non-English user asks, or the Marketplace data shows meaningful non-English installs.

## Do not add a walkthrough yet

`contributes.walkthroughs` is the platform's onboarding surface, and the extension has the surface area that usually justifies one: 20 commands, 22 settings, a status menu. It stays unbuilt because the first onboarding problem to solve is the passive failure where the extension never activates at all, which has its own ticket. A walkthrough for users who cannot get the extension running solves the wrong half.

**Revisit after** the activation cliff is fixed. Then a walkthrough is worth pricing on its own.

## Cancellable cache rebuild rides along the next scanner change

`rebuildPathCache` shows a progress notification with `cancellable: false`. Making it cancellable needs a `CancellationToken` threaded into the scanner, which belongs to a different review lane. The notification is non-blocking and the rebuild is user-initiated, so the cost of waiting is low.

**Revisit when** the scanner is next opened for other reasons, or a user reports the rebuild blocking them on a large project.

## Keep the single-file alias scan boundary

The alias scanner reads one file and does not follow aliases across the workspace. The comment defending this says a complete rule would need a workspace-wide scan that no line-based reader can make.

A review challenged that as overstated, on the grounds that the binding rule implies the directory chain. The challenge does not survive: `book-of-verse/Tests/Modules/Import.versetest:58-60` shows a cross-package alias resolving through a `using`, so a directory-chain walk closes only the lexical half of the rule. The stated justification is accurate as written.

**Revisit when** the extension gains a workspace-wide symbol index for another reason. The cost that makes this boundary right is building that index, so if it exists anyway the trade changes.

## Digest data reaches the repository through pull requests

A review found `.github/workflows/parse-digest.yml` committing regenerated digest JSON with `[skip ci]`, and filed it as untested data landing on the default branch.

It does not land that way. Every run of that workflow has failed at push: the token is read-only and a ruleset requires a pull request. Both digest refreshes to date arrived through PRs with CI green. The workflow's push step is dead code, not an open gate.

**Revisit when** the workflow's token or the branch ruleset changes. Either would turn the dead push step into the live hole the review thought it had found.

## A withheld duplicate import takes its comment run with it

When an import is withheld as a duplicate, the comment run written above it is deleted rather than left in place. This is the only path in the tool that discards prose the user typed.

It is deliberate, reasoned where it happens, and pinned by tests. A review argued against it on the grounds that orphaning the comment in place is strictly safer, and that the consolidation branch behaves differently, which looks like drift rather than a position. That argument is defensible, and it did not win: the protected event is rare, the behaviour is chosen rather than accidental, and no user has reported losing a comment this way.

This entry exists because the next reviewer will find it again and reach the same conclusion. It is a value trade, not a defect, and the trade has been made.

**Revisit when** a user reports losing a comment to a duplicate import, or when the consolidation branch is unified with the organize path — at which point the two behaviours must agree and this is the decision about which one wins.

## The relative-path speller diverges from Epic's on purpose

Epic's own `ConvertFullVersePathToRelativeDotSyntax` character-walks with ASCII folding, so it can end the common part in the middle of a label. This extension compares whole segments instead.

The divergence is deliberate and the comment describing it was checked against Epic's source and found accurate word for word. Mid-label spellings appear only in Epic's diagnostics, never in code a user writes, so matching Epic exactly would buy nothing and would introduce a bug.

**Revisit when** Epic emits a mid-label relative path somewhere a user could copy it into source.

This entry exists to stop a future "match Epic exactly" cleanup, which is the shape this looks like from the outside.

## The converter short-circuits on the nearest declaration

When a module is declared close to the referring file, the converter stops there rather than collecting every namesake in the project. That mirrors the compiler's own innermost-first walk, and it produces no quick-pick in the common case.

A distant namesake is therefore invisible to the user. That is not a defect; it is the compiler's semantics, and showing the user a choice the compiler has already made is the actual defect. That half is filed separately.

**Revisit when** the compiler's resolution order changes.

## Visibility edits refuse the whole request rather than applying part of it

When any file in a multi-file visibility edit raises a conflict, the writer declines everything instead of applying the rest. A writer whose worst case is a broken project-wide file should leave the project byte-identical on any doubt, and the refusal message names both conflict kinds and the remedy.

**Revisit when** partial application becomes safe, which needs the preview surface to exist first.

## The definitions file is rewritten whole, not patched

The visibility writer replaces the definitions file rather than making targeted edits. Its only failure mode is key drift, which is filed and being fixed.

**Revisit if** that key fix is declined. This decision is contingent on it: without the fix, the right shape is append-plus-targeted-edits, which removes the overlap fold and its double-write mode along with it.

## The logger keeps its own channels for now

Migrating the logger's display to the platform's `LogOutputChannel` would give standard log-level control and one Output entry instead of two, and delete roughly 200 lines of bespoke formatting. The ticket for it was written as a partial migration that keeps the ring buffer and the export command, so it does not carry the risk a naive full migration would — a `LogOutputChannel` filters at write time, which would destroy the retroactive detail that makes the export worth having.

It is deferred on cost and benefit alone. The logger works, and the export is the extension's flagship diagnostic.

**Revisit when** the Output-view experience becomes a priority, or when a change touches `logger.ts` internals for another reason and the migration can ride along.

---

Recorded 2026-08-13 and 2026-08-14, from a lane-by-lane review of the extension: platform, Verse reading, digest and project model, import writing, conversion and visibility, and a synthesis over all of them.

The evidence behind each entry — inventories, rubrics, findings and the refute rulings that re-derived them — is kept locally rather than in this repository, under `.claude/review/`. Each entry above is written to stand on its own, so a reader without those files loses the working, not the decision.
