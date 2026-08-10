import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../utils";
import { ProjectPathHandler } from "../project";
import { appendDeclarationBlock, buildDeclarationBlock } from "./definitionsContent";
import { findExplicitModuleDeclarations } from "./moduleDeclarations";
import { ModuleVisibilityRequest } from "./ModuleVisibilityMessage";
import { planVisibility, toContentSegments } from "./ModuleVisibilityPlanner";
import { FoundDeclaration, resolveVisibility, SpecifierEdit } from "./visibilityResolution";

/** The Content folder that anchors every module path, as in ImportPathConverter. */
const CONTENT_FOLDER = "Content";

/** Files read at a time while scanning for existing declarations, as in ProjectPathScanner. */
const SCAN_CONCURRENCY = 8;

/** Why an attempt to publicize a module produced no edit. */
type Refusal = { reason: string };

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
     * Refuses rather than half-applying: a module already narrowed to
     * `<private>`, `<protected>` or `<scoped>` is left alone, and so is
     * everything else the same request would have changed.
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

        const { declarations, files } = await this.findDeclarations(
            workspaceFolder,
            segments.map((segment) => segment.name),
        );
        const resolved = resolveVisibility(prefix, segments, declarations);

        if (resolved.conflicts.length > 0) {
            const listed = resolved.conflicts.map((conflict) => `${conflict.path} is <${conflict.keyword}>`).join(", ");
            return { reason: `making '${request.moduleName}' public would widen a deliberate restriction: ${listed}. Change it by hand if that is intended.` };
        }

        if (resolved.edits.length === 0 && resolved.chain.length === 0) {
            return { reason: `'${request.moduleName}' is already declared public.` };
        }

        const edit = new vscode.WorkspaceEdit();
        await this.addSpecifierEdits(edit, resolved.edits, files);

        let wroteDefinitions = false;
        if (resolved.chain.length > 0) {
            wroteDefinitions = await this.addDefinitionsEdit(edit, workspaceFolder, buildDeclarationBlock(resolved.chain));
            if (!wroteDefinitions) {
                return { reason: "the definitions file could not be read." };
            }
        }

        return { edit, summary: this.summarize(request.moduleName, resolved.edits.length, wroteDefinitions) };
    }

    /** Adds one specifier rewrite per existing declaration, resolving each file's offsets to positions. */
    private async addSpecifierEdits(edit: vscode.WorkspaceEdit, specifierEdits: readonly SpecifierEdit[], files: ReadonlyMap<string, vscode.Uri>): Promise<void> {
        const byFile = new Map<string, SpecifierEdit[]>();
        for (const specifierEdit of specifierEdits) {
            const existing = byFile.get(specifierEdit.file);
            if (existing) {
                existing.push(specifierEdit);
            } else {
                byFile.set(specifierEdit.file, [specifierEdit]);
            }
        }

        for (const [file, fileEdits] of byFile) {
            const uri = files.get(file);
            if (!uri) {
                continue;
            }
            const document = await vscode.workspace.openTextDocument(uri);

            for (const fileEdit of fileEdits) {
                if (fileEdit.span) {
                    edit.replace(uri, new vscode.Range(document.positionAt(fileEdit.span.start), document.positionAt(fileEdit.span.end)), fileEdit.text);
                } else {
                    edit.insert(uri, document.positionAt(fileEdit.offset), fileEdit.text);
                }
            }
        }
    }

    /**
     * Adds the definitions-file write, creating the file when it does not exist
     * yet. False when an existing file could not be read, which must not be
     * treated as an empty one - that would discard whatever it holds.
     */
    private async addDefinitionsEdit(edit: vscode.WorkspaceEdit, workspaceFolder: vscode.WorkspaceFolder, block: string): Promise<boolean> {
        const fileName = vscode.workspace.getConfiguration("verseAutoImports").get<string>("moduleVisibility.definitionsFileName", "definitions.verse");
        const contentRoot = path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER ? workspaceFolder.uri : vscode.Uri.joinPath(workspaceFolder.uri, CONTENT_FOLDER);
        const uri = vscode.Uri.joinPath(contentRoot, fileName);

        const existing = await vscode.workspace.fs.readFile(uri).then(
            (buffer) => Buffer.from(buffer).toString("utf8"),
            () => null,
        );

        if (existing === null) {
            edit.createFile(uri, { ignoreIfExists: true });
            edit.insert(uri, new vscode.Position(0, 0), appendDeclarationBlock("", block));
            return true;
        }

        const document = await vscode.workspace.openTextDocument(uri).then(
            (opened) => opened,
            () => null,
        );
        if (!document) {
            return false;
        }

        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), appendDeclarationBlock(existing, block));
        return true;
    }

    /**
     * Every explicit declaration of any of these module names in the project,
     * bound to its Content-relative path.
     *
     * The whole project is read rather than a capped sample: a declaration
     * missed here becomes a second, possibly conflicting part written into the
     * definitions file, which is a compile error rather than a worse
     * suggestion.
     */
    private async findDeclarations(workspaceFolder: vscode.WorkspaceFolder, names: readonly string[]): Promise<{ declarations: FoundDeclaration[]; files: Map<string, vscode.Uri> }> {
        const workspaceIsContent = path.basename(workspaceFolder.uri.fsPath) === CONTENT_FOLDER;
        const searchPattern = workspaceIsContent ? "**/*.verse" : `${CONTENT_FOLDER}/**/*.verse`;
        const verseFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, searchPattern), "**/*.digest.verse");
        const wanted = new Set(names);
        const declarations: FoundDeclaration[] = [];
        const files = new Map<string, vscode.Uri>();

        for (let i = 0; i < verseFiles.length; i += SCAN_CONCURRENCY) {
            const batch = await Promise.all(verseFiles.slice(i, i + SCAN_CONCURRENCY).map((file) => this.readDeclarations(file, workspaceFolder, workspaceIsContent, wanted)));
            for (const [index, fileDeclarations] of batch.entries()) {
                if (fileDeclarations.length > 0) {
                    const file = verseFiles[i + index];
                    files.set(file.toString(), file);
                    declarations.push(...fileDeclarations);
                }
            }
        }

        logger.debug("ModuleVisibilityWriter", `Scanned ${verseFiles.length} file(s), found ${declarations.length} matching declaration(s)`);
        return { declarations, files };
    }

    /** The wanted declarations in one file, or none when it cannot be read or sits outside Content. */
    private async readDeclarations(file: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder, workspaceIsContent: boolean, wanted: ReadonlySet<string>): Promise<FoundDeclaration[]> {
        const content = await vscode.workspace.fs.readFile(file).then(
            (buffer) => Buffer.from(buffer).toString("utf8"),
            () => null,
        );

        if (!content || !content.includes("module")) {
            return [];
        }

        const directory = this.contentRelativeDirectory(file, workspaceFolder, workspaceIsContent);
        if (directory === null) {
            return [];
        }

        const prefix = directory.length > 0 ? directory.split("/") : [];

        return findExplicitModuleDeclarations(content)
            .filter((declaration) => wanted.has(declaration.name))
            .map((declaration) => ({
                path: [...prefix, ...declaration.chain].join("/"),
                file: file.toString(),
                declaration,
            }));
    }

    /**
     * A file's directory relative to the Content root, "" at the root itself,
     * or null when the file sits outside Content. Mirrors the normalization in
     * ImportPathConverter's declaration scan.
     */
    private contentRelativeDirectory(file: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder, workspaceIsContent: boolean): string | null {
        let directory = path.dirname(path.relative(workspaceFolder.uri.fsPath, file.fsPath)).replace(/\\/g, "/");

        if (workspaceIsContent) {
            return directory === "" || directory === "." ? "" : directory;
        }

        if (directory === CONTENT_FOLDER) {
            return "";
        }
        if (directory.startsWith(`${CONTENT_FOLDER}/`)) {
            directory = directory.substring(CONTENT_FOLDER.length + 1);
            return directory;
        }
        return null;
    }

    /** What the user is told happened, which differs by whether an existing declaration was edited. */
    private summarize(moduleName: string, editCount: number, wroteDefinitions: boolean): string {
        if (editCount > 0 && wroteDefinitions) {
            return `made '${moduleName}' public: updated ${editCount} existing declaration(s) and wrote the definitions file.`;
        }
        if (editCount > 0) {
            return `made '${moduleName}' public by updating ${editCount} existing declaration(s).`;
        }
        return `made '${moduleName}' public in the definitions file.`;
    }
}
