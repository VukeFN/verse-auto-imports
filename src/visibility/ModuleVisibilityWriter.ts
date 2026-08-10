import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../utils";
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

/** A scanned file, and the exact text every offset taken from it addresses. */
interface ScannedFile {
    uri: vscode.Uri;
    text: string;
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
     * Makes the requested module reachable from the importing scope, and
     * reports what it did.
     *
     * Refuses rather than half-applying: a module declared anything but
     * `<public>` or `<internal>` is left alone, whether it is the one to
     * publicize or one a new declaration would sit inside, and so is everything
     * else the same request would have changed.
     */
    async makeModulePublic(request: ModuleVisibilityRequest): Promise<void> {
        const outcome = await this.buildEdit(request);

        if ("reason" in outcome) {
            logger.warn("ModuleVisibilityWriter", `Cannot publicize ${request.targetPath}: ${outcome.reason}`);
            vscode.window.showWarningMessage(`Verse Auto Imports: ${outcome.reason}`);
            return;
        }

        const applied = await vscode.workspace.applyEdit(outcome.edit);
        if (!applied) {
            logger.warn("ModuleVisibilityWriter", `Edit rejected for ${request.targetPath}`);
            vscode.window.showWarningMessage(`Verse Auto Imports: could not write the module visibility change for '${request.moduleName}'.`);
            return;
        }

        logger.info("ModuleVisibilityWriter", `Made ${request.targetPath} public`, { summary: outcome.summary });
        vscode.window.showInformationMessage(`Verse Auto Imports: ${outcome.summary}`);
    }

    /** The single edit that satisfies a request, or why there is none. */
    private async buildEdit(request: ModuleVisibilityRequest): Promise<{ edit: vscode.WorkspaceEdit; summary: string } | Refusal> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return { reason: "no workspace folder is open." };
        }

        const projectVersePath = await this.projectPathHandler.getProjectVersePath();
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

        const contentRoot = await this.findContentRoot(workspaceFolder);
        if (!contentRoot) {
            return { reason: `no '${CONTENT_FOLDER}' folder was found in the workspace, so there is nowhere to declare the module.` };
        }

        const definitionsUri = this.definitionsUri(contentRoot);
        if (!definitionsUri) {
            return { reason: "verseAutoImports.moduleVisibility.definitionsFileName must be a plain file name ending in .verse." };
        }
        const definitionsKey = definitionsUri.toString();

        // Every module on the path is looked up, the reachable prefix included:
        // the chain written into the definitions file has to nest through them,
        // and a part it writes must repeat whatever they already declare.
        const { declarations, scanned } = await this.findDeclarations(workspaceFolder, [...prefix, ...segments.map((segment) => segment.name)], definitionsKey);
        const resolved = resolveVisibility(prefix, segments, declarations);

        if (resolved.conflicts.length > 0) {
            return { reason: refusalForConflicts(request.moduleName, resolved.conflicts) };
        }

        if (resolved.edits.length === 0 && resolved.chain.length === 0) {
            return { reason: `'${request.moduleName}' is already declared public.` };
        }

        const edit = new vscode.WorkspaceEdit();

        // A specifier edit inside the definitions file would overlap the
        // whole-file replace below, which VS Code rejects, so it is folded into
        // that replacement's text instead of being applied separately.
        const inDefinitions = resolved.chain.length > 0 ? resolved.edits.filter((specifierEdit) => specifierEdit.file === definitionsKey) : [];
        const elsewhere = resolved.edits.filter((specifierEdit) => !inDefinitions.includes(specifierEdit));

        this.addSpecifierEdits(edit, elsewhere, scanned);

        if (resolved.chain.length > 0) {
            const existing = scanned.get(definitionsKey)?.text ?? (await this.readDefinitions(definitionsUri));
            if (existing === undefined) {
                return { reason: "the definitions file could not be read." };
            }

            const withEdits = applySpecifierEdits(existing, inDefinitions);
            const content = appendDeclarationBlock(withEdits, buildDeclarationBlock(resolved.chain));

            if (existing.length === 0 && !scanned.has(definitionsKey)) {
                edit.createFile(definitionsUri, { ignoreIfExists: true });
                edit.insert(definitionsUri, new vscode.Position(0, 0), content);
            } else {
                edit.replace(definitionsUri, new vscode.Range(new vscode.Position(0, 0), positionAt(existing, existing.length)), content);
            }
        }

        return { edit, summary: this.summarize(request.moduleName, resolved.edits, resolved.chain.length > 0) };
    }

    /** Adds one specifier rewrite per existing declaration, resolving offsets against the text they came from. */
    private addSpecifierEdits(edit: vscode.WorkspaceEdit, specifierEdits: readonly SpecifierEdit[], scanned: ReadonlyMap<string, ScannedFile>): void {
        for (const specifierEdit of specifierEdits) {
            const file = scanned.get(specifierEdit.file);
            if (!file) {
                continue;
            }

            const { start, end } = specifierEdit.span;
            if (start === end) {
                edit.insert(file.uri, positionAt(file.text, start), specifierEdit.text);
            } else {
                edit.replace(file.uri, new vscode.Range(positionAt(file.text, start), positionAt(file.text, end)), specifierEdit.text);
            }
        }
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
        const fileName = vscode.workspace.getConfiguration("verseAutoImports").get<string>("moduleVisibility.definitionsFileName", "definitions.verse").trim();

        if (!/^[^\\/:*?"<>|]+\.verse$/.test(fileName)) {
            return null;
        }

        return vscode.Uri.joinPath(contentRoot, fileName);
    }

    /**
     * The definitions file's text, "" when it does not exist, or undefined when
     * it exists but could not be read - which must not be treated as empty,
     * since that would discard whatever it holds.
     */
    private async readDefinitions(uri: vscode.Uri): Promise<string | undefined> {
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            return "";
        }

        try {
            return (await vscode.workspace.openTextDocument(uri)).getText();
        } catch {
            return undefined;
        }
    }

    /**
     * Every explicit declaration of any of these module names in the project,
     * bound to its Content-relative path, with the text each was read from.
     *
     * The whole project is read rather than a capped sample: a declaration
     * missed here becomes a second, possibly conflicting part written into the
     * definitions file, which is a compile error rather than a worse
     * suggestion. Text comes from openTextDocument, as ProjectPathScanner's
     * does, so an offset addresses the buffer the edit will be applied to
     * rather than what is currently on disk.
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
    ): Promise<{ declarations: FoundDeclaration[]; scanned: Map<string, ScannedFile> }> {
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

    /** The wanted declarations in one file, or null when it holds none, cannot be read, or sits outside Content. */
    private async readDeclarations(
        uri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        workspaceIsContent: boolean,
        wanted: ReadonlySet<string>,
    ): Promise<{ file: ScannedFile; declarations: FoundDeclaration[] } | null> {
        const directory = this.contentRelativeDirectory(uri, workspaceFolder, workspaceIsContent);
        if (directory === null) {
            return null;
        }

        const text = await vscode.workspace.openTextDocument(uri).then(
            (document) => document.getText(),
            () => null,
        );
        if (text === null || !text.includes("module")) {
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

        return { file: { uri, text }, declarations };
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

    /** What the user is told happened, naming the declarations that were rewritten. */
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
 * Why a request was refused, phrased per conflict kind because the two need
 * different things from the user: one is a specifier to change, the other a
 * declaration to write inside a module the quick fix will not open up.
 *
 * The keyword is named rather than rendered as a specifier: `scoped` is
 * declared with a module list, and printing `<scoped>` would quote the file as
 * saying something it does not say - and would not compile if pasted back.
 */
function refusalForConflicts(moduleName: string, conflicts: readonly VisibilityConflict[]): string {
    const listed = (reason: VisibilityConflict["reason"]) =>
        conflicts
            .filter((conflict) => conflict.reason === reason)
            .map((conflict) => `${conflict.path} is declared ${conflict.keyword}`)
            .join(", ");

    const widen = listed("widen");
    const nest = listed("nest");

    return [
        widen && `making '${moduleName}' public would widen a deliberate restriction: ${widen}. Change it by hand if that is intended.`,
        nest && `reaching '${moduleName}' would mean declaring a module inside a deliberately restricted one: ${nest}. Declare it there by hand if that is intended.`,
    ]
        .filter(Boolean)
        .join(" ");
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
