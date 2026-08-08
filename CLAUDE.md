# CLAUDE.md

VS Code extension that auto-manages `using` imports in `.verse` files for UEFN, driven by the Verse compiler's diagnostics.

## Commands

- `npm run compile` — build (tsc, no bundler)
- `npm test` — jest suite; `npx jest path/to.test.ts` for one file
- `npm run parse-digest` — regenerate the precompiled digest data
- `vsce package` — build the .vsix

No lint script. No automated end-to-end tests; smoke-test manually with F5 (Extension Development Host).

## Architecture gotchas

Read the code for structure. These are the things reading one file won't tell you:

- Go through the `ImportHandler` facade, never its internals (`ImportSuggestionExtractor`, `ImportFormatter`, `ImportDocumentEditor`).
- In `ImportSuggestionExtractor`, pattern-match order is load-bearing: multi-option before single-option before digest lookup. A new pattern must not shadow an existing one.
- `using` has two meanings: module imports (path starts with `/` or contains `.`) vs local-scope using (bare identifiers). `ImportFormatter.isModuleImport()` decides by content, and the indented `using:` style needs the next line to classify. Getting this wrong has caused real bugs.
- `npm run parse-digest` reads `src/utils/*.digest.verse` and writes `src/data/*.digest.json`. The `.verse` files are the checked-in input, copied in from a UEFN build or from `vz-creates/uefn` — replacing them by hand is how the bundled API surface is refreshed. The `.json` files are the generated output; never hand-edit those.

## Code style

- Prettier formats all TypeScript (config in `.prettierrc.json`, 4-space). Run `npm run format` before committing; CI runs `npm run format:check` and fails on unformatted code.
- TypeScript with relative imports (no path aliases).
- No emojis anywhere — code, comments, docs, commits, release notes.
- Every user-facing change gets a changelog fragment, not an edit to `CHANGELOG.md`: one file at `changelog.d/<key>.<category>.md` holding the entry prose only. The key is the tracked issue number, or a short slug when nothing tracks the change; the category is one of the Keep a Changelog six, lowercase. Never write a leading `- `, the `([#N])` tag, or a link definition — release assembly generates all three, and hand-writing them in one shared file is what made parallel branches conflict on `CHANGELOG.md`.
- An entry is a bold component name, a colon, and **one sentence** on the user-visible effect, at or under **40 words** excluding the tag. The mechanism belongs to the linked issue, not the changelog. A second sentence only where the reader must act. The full convention, with an example, is in [changelog.d/README](changelog.d/README).
- Use conventional commits.

## Testing

Jest + ts-jest; `vscode` is mocked at `src/__mocks__/vscode.ts`. Tests live in `__tests__/` beside the code. Add a regression test for any bug fix in pure logic (extractors, formatters, parsers) — those run without the VS Code runtime.

Epic account placeholders have one spelling per context: `/mygame@fortnite.com/mygame` in unit tests under `src/**/__tests__/`, and `/vukefn@fortnite.com` in the integration harness, the smoke fixtures under `test-fixtures/`, and prose examples such as JSDoc. Use the one the context calls for rather than inventing a third.

## Git workflow

GitHub Flow: `main` is the only long-lived branch and the default branch. There is no `develop`.

- Every change branches from `main` and returns by PR into `main`. Because PRs target the default branch, `Closes #N` in a PR body actually links and closes the issue — always use it.
- Branch prefixes: `feature/` `fix/` `chore/` `docs/` `test/` `refactor/`. A hotfix is just a `fix/` branch; it needs no special path.
- Merge method: every PR into `main` is **squash-merged**. The `Default Branch` ruleset restricts it — `squash` is the only merge method allowed there — so this is not convention alone, though repo admins can bypass that ruleset. Repo settings still permit merge commits, which governs any branch the ruleset does not cover.
- A squash merge replays the branch as one new commit, so a branch's own commits **never become ancestors of `main`**. Any check shaped like "is this commit on `main`" reports a fully-landed branch as unmerged; compare file content instead. Merge commits earlier in the history predate this convention — do not infer the merge method from `git log`.
- Release: a `chore/release-vX.Y.Z` PR into `main` bumps the version and finalizes the changelog. Merging it produces a draft GitHub Release; publishing that draft ships to the Marketplace.
- `release/X.Y` branches are cut **retroactively**, and only to patch an older released line. Do not create one in advance.

## Rules for automated agents (GitHub Actions runs)

YOU MUST:

- Never push to `main` — always branch and open a PR.
- Never change the `package.json` `version` except during release prep.
- Never close issues — label and comment; leave closing to the maintainer.
- Run `npm run compile` and `npm test` before opening a PR, and report the results in it.
- Keep issue and PR comments short and factual; one per run unless replying to a human.
