import * as path from "path";
import * as vscode from "vscode";
import { logger, settingsFor } from "../utils";
import { ProjectPathHandler } from "../project";
import { appendDeclarationBlock, buildDeclarationBlock } from "./definitionsContent";
import { findExplicitModuleDeclarations } from "./moduleDeclarations";
import { ModuleVisibilityRequest } from "./ModuleVisibilityMessage";
import { planVisibility, toContentSegments } from "./ModuleVisibilityPlanner";
import { FoundDeclaration, resolveVisibility, SpecifierEdit, VisibilityConflict } from "./visibilityResolution";

/** The Content folder that anchors every module path, as in ImportPathConverter. */
const CONTENT_FOLDER = "Content";

/** Files read at a time while scanning for existing declarations, as in ProjectPathScanner. */
const SCAN_CONCURRENCY = 8;

/** Why an attempt to publicize a module produced no edit. */
type Refusal = { reason: string };

/** The version recorded for a file that did not exist when it was read. */
const ABSENT = -1;

/** A scanned file, and the exact text every offset taken from it addresses. */
interface ScannedFile {
    uri: vscode.Uri;
    text: string;
    version: number;
}

/**
 * A file as it stood when its text was read, so a change made while the rest of
 * the project was still being scanned can be caught before anything is written.
 *
 * `version` is ABSENT for a file that did not exist. The definitions file is
 * created with `ignoreIfExists`, so one that appears during the scan would
 * otherwise be prepended to rather than created.
 */
interface Snapshot {
    uri: vscode.Uri;
    version: number;
}

/**
 * A project file the scan listed but could not open.
 *
 * Not a file that declares nothing: a part written in ignorance of one it holds
 * can disagree with it, which the compiler rejects.
 */
interface UnreadableFile {
    unreadable: vscode.Uri;
}

/**
 * Applies the `<public>` declarations that make an internal module reachable.
 *
 * The whole project is scanned before anything is written, because a second
 * explicit part of a module that disagrees with the first is a compile error
 * rather than a no-op - see resolveVisibility for the two rules that avoid it.
 */
export class ModuleVisibilityWriter {
    constructor(
        private readonly outputChannel: vscode.OutputChannel,
        private readonly projectPathHandler: ProjectPathHandler,
    ) {}

    /**
     * Puts the `<public>` declarations that make the requested module
     * reachable through the refactor preview, and reports what came back.
     *
     * Refuses rather than half-applying, and everything else the same request
     * would have changed goes with it. A module declared anything but
     * `<public>` or `<internal>` is left alone, whether it is the one to
     * publicize or one a new declaration would sit inside; so is one the chain
     * would have to declare a second time, since the block is appended whole
     * and cannot join a declaration the project already carries. That governs
     * what is offered, not what lands - the preview lets the user apply a
     * subset, so what is reported afterwards is intent rather than outcome.
     *
     * @param sourceUri the document whose diagnostic asked for this, which is
     * what picks the workspace folder in a multi-root workspace. The first
     * folder is used instead whenever this names nothing usable - it is
     * absent, it sits outside every folder, or its folder holds no Content
     * root - so a caller that cannot name a document still gets the
     * single-root behaviour rather than a refusal.
     */
    async makeModulePublic(request: ModuleVisibilityRequest, sourceUri?: vscode.Uri): Promise<void> {
        const outcome = await this.buildEdit(request, sourceUri);

        if ("reason" in outcome) {
            logger.warn("ModuleVisibilityWriter", `Cannot publicize ${request.targetPath}: ${outcome.reason}`);
            vscode.window.showWarningMessage(`Verse Auto Imports: ${outcome.reason}`);
            return;
        }

        // As late as possible, and never earlier: every moment between this
        // check and applyEdit is window the check cannot cover.
        const drifted = await this.findDrift(outcome.snapshots);
        if (drifted) {
            const name = vscode.workspace.asRelativePath(drifted, false);
            logger.warn("ModuleVisibilityWriter", `Stale scan for ${request.targetPath}: ${drifted.toString()} changed`);
            vscode.window.showWarningMessage(`Verse Auto Imports: '${name}' changed while the project was scanned, so nothing was written. Run the fix again.`);
            return;
        }

        // isRefactoring does not open the preview - it only makes
        // files.refactoring.autoSave apply. The preview comes from the
        // needsConfirmation metadata buildEdit puts on every entry.
        const applied = await vscode.workspace.applyEdit(outcome.edit, { isRefactoring: true });
        if (!applied) {
            // A cancelled preview, a preview nothing was selected in, and a
            // failed apply all arrive as false, so neither the log line nor
            // the notification can claim which of them happened. Logged at
            // info because cancelling is an ordinary user action and the most
            // likely way to get here.
            logger.info("ModuleVisibilityWriter", `Nothing written for ${request.targetPath}: the preview was cancelled or empty, or the edit failed`);
            vscode.window.showInformationMessage(`Verse Auto Imports: no changes were written for '${request.moduleName}'.`);
            return;
        }

        // Only what was offered is known, never what was ticked, so the
        // summary is logged as intent and kept out of the notification.
        logger.info("ModuleVisibilityWriter", `Applied the previewed changes for ${request.targetPath}`, { intended: outcome.summary });
        vscode.window.showInformationMessage(`Verse Auto Imports: applied the previewed changes for '${request.moduleName}'.`);
    }

    /**
     * The single edit that satisfies a request, with what every file it was
     * computed from looked like at read time, or why there is none.
     *
     * The folder this resolves decides all four of the Content root written
     * to, the project Verse path every module path is measured against, the
     * scope `moduleVisibility.definitionsFileName` is read at, and the subtree
     * the declaration scan sweeps, so a wrong one rules on declarations it
     * never read rather than merely writing the wrong file.
     */
    private async buildEdit(request: ModuleVisibilityRequest, sourceUri?: vscode.Uri): Promise<{ edit: vscode.WorkspaceEdit; summary: string; snapshots: Snapshot[] } | Refusal> {
        // The target module cannot be resolved to a folder directly: its path
        // is a Verse path, and turning one into a URI needs the Content root
        // this is on the way to finding. The requesting document is in the
        // right folder already, and the target shares it - the compiler
        // resolved both under one projectVersePath.
        const requestedFolder = sourceUri ? vscode.workspace.getWorkspaceFolder(sourceUri) : undefined;
        const firstFolder = vscode.workspace.workspaceFolders?.[0];
        if (!requestedFolder && !firstFolder) {
            return { reason: "no workspace folder is open." };
        }

        // A folder holding no Content root cannot host the declaration, and a
        // workspace can carry one legitimately - notes or art opened alongside
        // the project. A document in such a folder falls back rather than
        // refusing, since the project's own folder can still serve it.
        const located = (await this.locateContentRoot(requestedFolder)) ?? (await this.locateContentRoot(firstFolder));
        if (!located) {
            return { reason: `no '${CONTENT_FOLDER}' folder was found in the workspace, so there is nowhere to declare the module.` };
        }
        const { workspaceFolder, contentRoot } = located;

        // Read for the folder that won above rather than for the requesting
        // document, because the fallback can settle on a different one. A path
        // taken from the document's folder would then name a project this edit
        // is not being written into, and every segment below is measured
        // against it.
        const projectVersePath = await this.projectPathHandler.getProjectVersePath(workspaceFolder.uri);
        if (!projectVersePath) {
            return { reason: "no .uefnproject file was found, so module paths cannot be resolved." };
        }

        const targetSegments = toContentSegments(request.targetPath, projectVersePath);
        const importerSegments = toContentSegments(request.importerPath, projectVersePath);
        if (!targetSegments || !importerSegments) {
            return { reason: `'${request.targetPath}' is outside the project '${projectVersePath}'.` };
        }

        const { prefix, segments } = planVisibility(targetSegments, importerSegments);
        if (segments.length === 0) {
            return { reason: `'${request.moduleName}' is already reachable from the importing module.` };
        }

        const definitionsUri = this.definitionsUri(contentRoot);
        if (!definitionsUri) {
            return { reason: "verseAutoImports.moduleVisibility.definitionsFileName must be a plain file name ending in .verse." };
        }
        const definitionsKey = definitionsUri.toString();

        // Every module on the path is looked up, the reachable prefix included:
        // the chain written into the definitions file has to nest through them,
        // and a part it writes must repeat whatever they already declare.
        const scan = await this.findDeclarations(workspaceFolder, [...prefix, ...segments.map((segment) => segment.name)], definitionsKey);
        if ("unreadable" in scan) {
            return { reason: `'${vscode.workspace.asRelativePath(scan.unreadable, false)}' could not be read, so whether it declares part of '${request.moduleName}' is unknown.` };
        }

        const { declarations, scanned } = scan;
        const resolved = resolveVisibility(prefix, segments, declarations);

        if (resolved.conflicts.length > 0) {
            return { reason: refusalForConflicts(request.moduleName, resolved.conflicts) };
        }

        if (resolved.edits.length === 0 && resolved.chain.length === 0) {
            return { reason: `'${request.moduleName}' is already declared public.` };
        }

        const edit = new vscode.WorkspaceEdit();

        // needsConfirmation on an entry is the only thing an extension can set
        // that opens the refactor preview, and it must go on every entry the
        // user is meant to see - one without it is applied unseen. One shared
        // label names the whole refactoring, and gathers the entries under a
        // single node in the preview's group-by-category view.
        const confirm = (description: string): vscode.WorkspaceEditEntryMetadata => ({
            needsConfirmation: true,
            label: `Make module '${request.moduleName}' public`,
            description,
        });

        // Every scanned file, not only the ones an edit addresses: the text of
        // each fed resolveVisibility's ruling, so a change to any of them
        // invalidates the whole result rather than one offset.
        const snapshots: Snapshot[] = [...scanned.values()].map((file) => ({ uri: file.uri, version: file.version }));

        // A specifier edit inside the definitions file would overlap the
        // whole-file replace below, which VS Code rejects, so it is folded into
        // that replacement's text instead of being applied separately.
        const inDefinitions = resolved.chain.length > 0 ? resolved.edits.filter((specifierEdit) => specifierEdit.file === definitionsKey) : [];
        const elsewhere = resolved.edits.filter((specifierEdit) => !inDefinitions.includes(specifierEdit));

        this.addSpecifierEdits(edit, elsewhere, scanned, confirm);

        if (resolved.chain.length > 0) {
            const scannedDefinitions = scanned.get(definitionsKey);
            const definitions = scannedDefinitions ?? (await this.readDefinitions(definitionsUri));
            if (definitions === undefined) {
                return { reason: "the definitions file could not be read." };
            }
            if (!scannedDefinitions) {
                snapshots.push({ uri: definitionsUri, version: definitions.version });
            }

            const existing = definitions.text;
            const withEdits = applySpecifierEdits(existing, inDefinitions);
            const content = appendDeclarationBlock(withEdits, buildDeclarationBlock(resolved.chain));

            // The module path, as the specifier entries carry, rather than the
            // file name: the preview groups by file by default, so the name is
            // already on the node above and the description would say nothing.
            const metadata = confirm(resolved.chain.map((segment) => segment.name).join("/"));
            if (existing.length === 0 && !scannedDefinitions) {
                edit.createFile(definitionsUri, { ignoreIfExists: true }, metadata);
                edit.insert(definitionsUri, new vscode.Position(0, 0), content, metadata);
            } else {
                edit.replace(definitionsUri, new vscode.Range(new vscode.Position(0, 0), positionAt(existing, existing.length)), content, metadata);
            }
        }

        return { edit, summary: this.summarize(request.moduleName, resolved.edits, resolved.chain.length > 0), snapshots };
    }

    /**
     * The first file that changed since its text was read, or null when every
     * one still stands as it was.
     *
     * A file that no longer opens counts as changed: it was readable when the
     * offsets were taken from it, so whatever happened to it since invalidates
     * them. VS Code offers nothing atomic here - WorkspaceEdit carries no
     * version and applyEdit accepts none - so this narrows the window to the
     * gap before the apply rather than closing it.
     *
     * That window is now the whole preview session, because applyEdit does not
     * return until the user dismisses the preview. Text edits still fail closed
     * past this point: the extension host stamps a version on edits to
     * documents it knows, and a stale one aborts the apply. The createFile path
     * does not, having no document to stamp - a definitions file created while
     * the preview sits open is kept by `ignoreIfExists`, and the block is then
     * prepended to it.
     */
    private async findDrift(snapshots: readonly Snapshot[]): Promise<vscode.Uri | null> {
        for (const snapshot of snapshots) {
            if (snapshot.version === ABSENT) {
                const created = await vscode.workspace.fs.stat(snapshot.uri).then(
                    () => true,
                    () => false,
                );
                if (created) {
                    return snapshot.uri;
                }
                continue;
            }

            const version = await vscode.workspace.openTextDocument(snapshot.uri).then(
                (document) => document.version,
                () => null,
            );
            if (version !== snapshot.version) {
                return snapshot.uri;
            }
        }

        return null;
    }

    /**
     * Adds one specifier rewrite per existing declaration, resolving offsets
     * against the text they came from.
     *
     * @param confirm builds the metadata each entry carries into the preview,
     * from the description that entry should show.
     */
    private addSpecifierEdits(
        edit: vscode.WorkspaceEdit,
        specifierEdits: readonly SpecifierEdit[],
        scanned: ReadonlyMap<string, ScannedFile>,
        confirm: (description: string) => vscode.WorkspaceEditEntryMetadata,
    ): void {
        for (const specifierEdit of specifierEdits) {
            const file = scanned.get(specifierEdit.file);
            if (!file) {
                // Every SpecifierEdit.file is a key findDeclarations put in
                // `scanned`, so a miss means the two disagree about which files
                // were read. Skipping the edit would half-apply the module.
                logger.error("ModuleVisibilityWriter", `No scanned text for ${specifierEdit.file}`);
                throw new Error(`ModuleVisibilityWriter: no scanned text for ${specifierEdit.file}`);
            }

            const metadata = confirm(specifierEdit.path);
            const { start, end } = specifierEdit.span;
            if (start === end) {
                edit.insert(file.uri, positionAt(file.text, start), specifierEdit.text, metadata);
            } else {
                edit.replace(file.uri, new vscode.Range(positionAt(file.text, start), positionAt(file.text, end)), specifierEdit.text, metadata);
            }
        }
    }

    /** A folder paired with its Content root, or null when there is no folder or it holds none. */
    private async locateContentRoot(folder: vscode.WorkspaceFolder | undefined): Promise<{ workspaceFolder: vscode.WorkspaceFolder; contentRoot: vscode.Uri } | null> {
        if (!folder) {
            return null;
        }

        const contentRoot = await this.findContentRoot(folder);
        return contentRoot ? { workspaceFolder: folder, contentRoot } : null;
    }

    /** The Content folder the project's modules hang off, or null when the workspace has none. */
    private async findContentRoot(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri | null> {
        if (path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER) {
            return workspaceFolder.uri;
        }

        const candidate = vscode.Uri.joinPath(workspaceFolder.uri, CONTENT_FOLDER);
        try {
            const stat = await vscode.workspace.fs.stat(candidate);
            return stat.type === vscode.FileType.Directory ? candidate : null;
        } catch {
            return null;
        }
    }

    /**
     * The configured definitions file, at the Content root, or null when the
     * setting does not name one.
     *
     * The setting is a file NAME, so anything carrying a path is refused rather
     * than resolved: `Uri.joinPath` would place the file in another directory,
     * or outside Content entirely, and an empty value would address the Content
     * directory itself. The `.verse` suffix is required because a file the
     * compiler does not read would leave the error standing while the quick fix
     * reported success.
     */
    private definitionsUri(contentRoot: vscode.Uri): vscode.Uri | null {
        const fileName = settingsFor(contentRoot).get<string>("moduleVisibility.definitionsFileName", "_definitions.verse").trim();

        if (!/^[^\\/:*?"<>|]+\.verse$/.test(fileName)) {
            return null;
        }

        return vscode.Uri.joinPath(contentRoot, fileName);
    }

    /**
     * The definitions file's text and the version it was read at, "" at ABSENT
     * when it does not exist, or undefined when it exists but could not be read
     * - which must not be treated as empty, since that would discard whatever
     * it holds.
     *
     * The undefined is now rare rather than gone: where findFiles listed the
     * file, findDeclarations opens it first and refuses there instead.
     */
    private async readDefinitions(uri: vscode.Uri): Promise<{ text: string; version: number } | undefined> {
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            return { text: "", version: ABSENT };
        }

        try {
            const document = await vscode.workspace.openTextDocument(uri);
            return { text: document.getText(), version: document.version };
        } catch {
            return undefined;
        }
    }

    /**
     * Every explicit declaration of any of these module names in the project,
     * bound to its Content-relative path, with the text each was read from, or
     * the first file the scan could not open.
     *
     * The whole project is read rather than a capped sample: a declaration
     * missed here becomes a second, possibly conflicting part written into the
     * definitions file, which is a compile error rather than a worse
     * suggestion. The scan is therefore all-or-nothing: a file it cannot open
     * stops it, and the caller must fail closed on that rather than proceed on
     * a partial answer. Text comes from openTextDocument, as
     * ProjectPathScanner's does, so an offset addresses the buffer the edit will
     * be applied to rather than what is currently on disk.
     *
     * @param definitionsKey the definitions file, whose text is kept even when
     * it declares none of these modules, because the caller appends to it. A
     * file holding no module declaration at all is skipped before that, and
     * reaches the caller through readDefinitions instead.
     */
    private async findDeclarations(
        workspaceFolder: vscode.WorkspaceFolder,
        names: readonly string[],
        definitionsKey: string,
    ): Promise<{ declarations: FoundDeclaration[]; scanned: Map<string, ScannedFile> } | UnreadableFile> {
        const workspaceIsContent = path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER;
        const searchPattern = workspaceIsContent ? "**/*.verse" : `${CONTENT_FOLDER}/**/*.verse`;
        const verseFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, searchPattern), "**/*.digest.verse");
        const wanted = new Set(names);
        const declarations: FoundDeclaration[] = [];
        const scanned = new Map<string, ScannedFile>();

        for (let i = 0; i < verseFiles.length; i += SCAN_CONCURRENCY) {
            const batch = await Promise.all(verseFiles.slice(i, i + SCAN_CONCURRENCY).map((file) => this.readDeclarations(file, workspaceFolder, workspaceIsContent, wanted)));
            for (const result of batch) {
                if (!result) {
                    continue;
                }
                if ("unreadable" in result) {
                    // The caller refuses on this, and reports it, so the rest
                    // of the scan has nothing left to answer.
                    logger.debug("ModuleVisibilityWriter", `Stopped the scan at unreadable file ${result.unreadable.toString()}`);
                    return result;
                }
                const key = result.file.uri.toString();
                if (result.declarations.length > 0 || key === definitionsKey) {
                    scanned.set(key, result.file);
                    declarations.push(...result.declarations);
                }
            }
        }

        logger.debug("ModuleVisibilityWriter", `Scanned ${verseFiles.length} file(s), found ${declarations.length} matching declaration(s)`);
        return { declarations, scanned };
    }

    /**
     * The wanted declarations in one file, null when it holds none or sits
     * outside Content, or the file itself when it could not be opened.
     *
     * The last is not one of the nulls: those two files declare nothing, where
     * an unopened one is unknown. The outside-Content test runs first and
     * deliberately - a file there is skipped without ever being opened, so an
     * unreadable one cannot refuse the request.
     */
    private async readDeclarations(
        uri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        workspaceIsContent: boolean,
        wanted: ReadonlySet<string>,
    ): Promise<{ file: ScannedFile; declarations: FoundDeclaration[] } | UnreadableFile | null> {
        const directory = this.contentRelativeDirectory(uri, workspaceFolder, workspaceIsContent);
        if (directory === null) {
            return null;
        }

        // Text and version come off the same document object, so the version
        // recorded is the one this exact text was read at.
        const read = await vscode.workspace.openTextDocument(uri).then(
            (document) => ({ text: document.getText(), version: document.version }),
            () => null,
        );
        if (read === null) {
            return { unreadable: uri };
        }
        const { text } = read;
        if (!text.includes("module")) {
            return null;
        }

        const prefix = directory.length > 0 ? directory.split("/") : [];
        const declarations = findExplicitModuleDeclarations(text)
            .filter((declaration) => wanted.has(declaration.name))
            .map((declaration) => ({
                path: [...prefix, ...declaration.chain].join("/"),
                file: uri.toString(),
                declaration,
            }));

        return { file: { uri, text, version: read.version }, declarations };
    }

    /**
     * A file's directory relative to the Content root, "" at the root itself,
     * or null when the file sits outside Content. Mirrors the normalization in
     * ImportPathConverter's declaration scan.
     */
    private contentRelativeDirectory(file: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder, workspaceIsContent: boolean): string | null {
        const directory = path.dirname(path.relative(workspaceFolder.uri.fsPath, file.fsPath)).replace(/\\/g, "/");

        if (workspaceIsContent) {
            return directory === "" || directory === "." ? "" : directory;
        }

        if (directory === CONTENT_FOLDER) {
            return "";
        }
        if (directory.startsWith(`${CONTENT_FOLDER}/`)) {
            return directory.substring(CONTENT_FOLDER.length + 1);
        }
        return null;
    }

    /**
     * What the edit would do, naming the declarations it rewrites. This is the
     * offer, not the result: the user can apply part of it in the preview, so
     * it is logged rather than shown as a report of what was written.
     */
    private summarize(moduleName: string, edits: readonly SpecifierEdit[], wroteDefinitions: boolean): string {
        const rewritten = [...new Set(edits.map((edit) => edit.path))];

        if (rewritten.length > 0 && wroteDefinitions) {
            return `made '${moduleName}' public: declared ${rewritten.join(", ")} public in place and wrote the definitions file.`;
        }
        if (rewritten.length > 0) {
            return `made '${moduleName}' public by declaring ${rewritten.join(", ")} public in place.`;
        }
        return `made '${moduleName}' public in the definitions file.`;
    }
}

/**
 * Why a request was refused, naming what each conflicting module would have
 * needed. The kinds are phrased apart because they ask different things of the
 * user, and one sentence carries them all so a notification does not clip a
 * remedy before it is read.
 */
function refusalForConflicts(moduleName: string, conflicts: readonly VisibilityConflict[]): string {
    // Bracketed rather than trailing a comma, and the list punctuated: one
    // conflict per declared ancestor is ordinary, and a reader given
    // `A and B, declared internal and C` cannot tell where a path ends.
    const joined = (items: readonly string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);

    const listed = (reason: VisibilityConflict["reason"]) =>
        joined(
            conflicts
                .filter((conflict) => conflict.reason === reason)
                // A repeat of a declaration carrying no specifier has no
                // keyword to name, and `declared undefined` would read as one
                // it does carry.
                .map((conflict) => (conflict.keyword ? `${conflict.path} (declared ${conflict.keyword})` : conflict.path)),
        );

    const widen = listed("widen");
    const nest = listed("nest");
    const repeat = listed("repeat");
    const clauses = [widen && `widening ${widen}`, nest && `declaring a module inside ${nest}`, repeat && `re-declaring ${repeat}`].filter(Boolean);

    // Semicolons between clauses, because the lists inside them already spend
    // ", and": one separator doing both jobs leaves the gerund as the only mark
    // of where a clause starts.
    return `making '${moduleName}' reachable would mean ${clauses.join("; ")}. Make the change by hand if that is intended.`;
}

/** The text with every specifier rewrite applied, taken last-first so earlier offsets stay valid. */
function applySpecifierEdits(text: string, edits: readonly SpecifierEdit[]): string {
    return [...edits].sort((a, b) => b.span.start - a.span.start).reduce((current, edit) => current.slice(0, edit.span.start) + edit.text + current.slice(edit.span.end), text);
}

/** The position an offset falls at in the text the offset was taken from. */
function positionAt(text: string, offset: number): vscode.Position {
    const before = text.slice(0, offset).split("\n");
    return new vscode.Position(before.length - 1, before[before.length - 1].length);
}
