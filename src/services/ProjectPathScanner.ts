import * as vscode from "vscode";
import { logger } from "../utils";
import { ProjectPathHandler } from "../project";
import { ProjectPathData, ProjectPathNode, ProjectScanOptions } from "../types";

/** Number of .verse files parsed concurrently during a full scan. */
const SCAN_CONCURRENCY = 8;

/**
 * Reads the project's .verse files into a flat list of the module, class,
 * struct, interface, enum, function and variable declarations they make.
 *
 * The nesting a declaration sits in survives only as the dotted `fullPath` on
 * each node; nothing here returns a tree.
 */
export class ProjectPathScanner {
    constructor(
        private outputChannel: vscode.OutputChannel,
        private projectPathHandler: ProjectPathHandler,
    ) {}

    /**
     * Every declaration across the workspace's .verse files, or null when no
     * UEFN project was found and null again when the scan itself failed - a
     * caller cannot tell the two apart, and neither raises.
     */
    async scanProject(workspaceFolder: vscode.WorkspaceFolder, options: ProjectScanOptions = {}): Promise<ProjectPathData | null> {
        const startTime = Date.now();
        logger.info("ProjectPathScanner", `Scanning project ${workspaceFolder.name}...`);

        try {
            const projectVersePath = await this.projectPathHandler.getProjectVersePath();
            const projectName = await this.projectPathHandler.getProjectName();

            if (!projectName) {
                logger.warn("ProjectPathScanner", "No UEFN project found in workspace");
                return null;
            }

            const includePattern = options.includePatterns?.[0] || "**/*.verse";
            const excludePatterns = options.excludePatterns || ["**/node_modules/**", "**/.git/**"];
            const excludePattern = `{${excludePatterns.join(",")}}`;

            const files = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, includePattern), excludePattern);

            logger.debug("ProjectPathScanner", `Found ${files.length} .verse files`);

            const nodes: ProjectPathNode[] = [];
            let processedCount = 0;

            for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
                const batch = files.slice(i, i + SCAN_CONCURRENCY);
                const batchResults = await Promise.all(
                    batch.map(async (fileUri) => {
                        try {
                            // A full scan has no previous declarations to keep,
                            // so an unreadable file contributes nothing either way.
                            return (await this.parseVerseFile(fileUri, workspaceFolder, options)) ?? [];
                        } catch (error) {
                            logger.error("ProjectPathScanner", `Error parsing ${fileUri.fsPath}`, error);
                            return [];
                        }
                    }),
                );

                for (let j = 0; j < batch.length; j++) {
                    nodes.push(...batchResults[j]);
                    processedCount++;
                    if (options.onProgress) {
                        const relativePath = vscode.workspace.asRelativePath(batch[j], false);
                        options.onProgress(processedCount, files.length, relativePath);
                    }
                }
            }

            const elapsed = Date.now() - startTime;
            logger.info("ProjectPathScanner", `Scanned ${nodes.length} declarations from ${files.length} files in ${elapsed}ms`);

            return {
                projectVersePath: projectVersePath || `/${projectName}`,
                projectName,
                generatedAt: Date.now(),
                nodes,
            };
        } catch (error) {
            logger.error("ProjectPathScanner", "Failed to scan project", error);
            return null;
        }
    }

    /**
     * The declarations in one .verse file, or null when it could not be read or
     * parsed. Null and [] are different answers: [] is a file that was read and
     * declares nothing, and a caller that conflates them treats an unreadable
     * file as an emptied one. A failure here is logged and does not raise, so
     * one unreadable file cannot abandon a whole scan.
     */
    async parseVerseFile(fileUri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder, options: ProjectScanOptions = {}): Promise<ProjectPathNode[] | null> {
        try {
            const document = await vscode.workspace.openTextDocument(fileUri);
            const content = document.getText();
            const relativePath = vscode.workspace.asRelativePath(fileUri, false);

            return this.extractDeclarations(content, relativePath, options);
        } catch (error) {
            logger.error("ProjectPathScanner", `Failed to parse ${fileUri.fsPath}`, error);
            return null;
        }
    }

    /**
     * The declarations in a file's text, in source order.
     *
     * `sourceLine` is 1-based, so it is one more than the `vscode.Position` line
     * for the same declaration. `fullPath` carries the dotted chain of enclosing
     * modules, so it equals `name` only at file scope. Declarations nested in a
     * class or struct body are not filtered out here; only indentation-scoped
     * module nesting is tracked.
     */
    extractDeclarations(content: string, filePath: string, options: ProjectScanOptions = {}): ProjectPathNode[] {
        const nodes: ProjectPathNode[] = [];
        const lines = content.split("\n");

        let currentModulePath = "";
        const moduleStack: { name: string; indent: number }[] = [];

        const visibilitySpecifiers = "public|protected|private|internal|scoped";

        // A declaration carries any number of stacked specifiers, of which at
        // most one is a visibility; the rest (<native>, <final>, ...) are noise
        // to this scan.
        const extractVisibility = (specifiers: string | undefined): string | undefined => {
            if (!specifiers) return undefined;
            const match = specifiers.match(new RegExp(`<(${visibilitySpecifiers})>`));
            return match ? match[1] : undefined;
        };

        const shouldSkipDeclaration = (visibility: string | undefined, isModuleType: boolean = false): boolean => {
            if (!options.includePrivate && visibility === "private") {
                return true;
            }
            // By default a module is kept only when it is public or internal,
            // and no specifier at all means internal in Verse. Anything
            // narrower cannot be imported from outside. includePrivate lifts
            // this along with the private check above, keeping everything.
            if (isModuleType) {
                const isPublic = visibility === "public";
                const isInternal = !visibility || visibility === "internal";
                if (!options.includePrivate && !isPublic && !isInternal) {
                    return true;
                }
            }
            return false;
        };

        // Every pattern below captures [1] the declared name and [2] the
        // specifiers attached to that name, matching the shape
        // `Name<spec><spec> := type<typespec>(parent):`. Specifiers to the
        // right of `:=` belong to the type, not the name, and are skipped
        // rather than captured - except by modulePattern, which allows none
        // there and so does not match a module carrying them.
        //
        // A module body is written in any of the three styles Verse gives a
        // macro, so the keyword ends at `:`, `{` or `.`, and at the line end
        // when the brace opens on the next line. `>` matches the terminators
        // ImportPathConverter.buildModuleDefinitionRegex accepts. This line is
        // matched trimmed, so the alternative is what reaches a next-line
        // brace that regex reads through `\s*` over the whole file.
        const modulePattern = /^(\w+)((?:<[^>]+>)*)\s*:=\s*module\s*(?:[:>{.]|$)/;
        const classPattern = /^(\w+)((?:<[^>]+>)*)\s*:=\s*class\s*(?:<[^>]+>)*\s*[\(:]?/;
        const structPattern = /^(\w+)((?:<[^>]+>)*)\s*:=\s*struct\s*(?:<[^>]+>)*\s*[\(:]?/;
        const interfacePattern = /^(\w+)((?:<[^>]+>)*)\s*:=\s*interface\s*(?:<[^>]+>)*\s*[\(:]?/;
        const enumPattern = /^(\w+)((?:<[^>]+>)*)\s*:=\s*enum\s*(?:<[^>]+>)?\s*:/;
        /** `Name<specifiers>(params)<effects>:` */
        const functionPattern = /^(\w+)((?:<[^>]+>)*)\s*\([^)]*\)\s*(?:<[^>]+>)*\s*:/;
        /** `(Type:type).Name<specifiers>(params)<effects>:` */
        const extensionMethodPattern = /^\([^)]+\)\.(\w+)((?:<[^>]+>)*)\s*\([^)]*\)/;
        const variablePattern = /^(\w+)((?:<[^>]+>)*)\s*:/;

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const line = rawLine.trim();

            if (line === "" || line.startsWith("#") || line.startsWith("//")) {
                continue;
            }

            if (line.startsWith("using")) {
                continue;
            }

            // Each tab counts as four spaces so mixed indentation compares
            // consistently.
            const indentMatch = rawLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1].replace(/\t/g, "    ").length : 0;

            // Indentation alone closes a module: a line at or left of the open
            // module's own indent is outside it.
            while (moduleStack.length > 0 && indent <= moduleStack[moduleStack.length - 1].indent) {
                moduleStack.pop();
            }
            currentModulePath = moduleStack.length > 0 ? moduleStack[moduleStack.length - 1].name : "";

            const moduleMatch = line.match(modulePattern);
            if (moduleMatch) {
                const [, name, specifiers] = moduleMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility, true)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;
                moduleStack.push({ name: fullPath, indent });
                currentModulePath = fullPath;

                nodes.push({
                    name,
                    fullPath,
                    type: "module",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const classMatch = line.match(classPattern);
            if (classMatch) {
                const [, name, specifiers] = classMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "class",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const structMatch = line.match(structPattern);
            if (structMatch) {
                const [, name, specifiers] = structMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "struct",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const interfaceMatch = line.match(interfacePattern);
            if (interfaceMatch) {
                const [, name, specifiers] = interfaceMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "interface",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const enumMatch = line.match(enumPattern);
            if (enumMatch) {
                const [, name, specifiers] = enumMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "enum",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const extensionMatch = line.match(extensionMethodPattern);
            if (extensionMatch) {
                const [, name, specifiers] = extensionMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "function",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            const functionMatch = line.match(functionPattern);
            if (functionMatch) {
                const [, name, specifiers] = functionMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "function",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
                continue;
            }

            // Last, and it must stay last. The `:` this pattern needs is also
            // the first character of the `:=` that opens a type declaration, so
            // it matches those too; the branches above only win by being asked
            // first, and the guards below cover the shapes they did not match.
            const variableMatch = line.match(variablePattern);
            if (variableMatch) {
                const [, name, specifiers] = variableMatch;
                const visibility = extractVisibility(specifiers);
                const isPublic = visibility === "public";

                if (shouldSkipDeclaration(visibility)) {
                    continue;
                }

                // Both guards are backstops for a declaration whose specific
                // pattern above did not match the exact shape written: a type,
                // recognised by `:=` with a declaration keyword, and a function,
                // recognised by a parameter list before the colon. Either would
                // otherwise be recorded as a variable.
                if (line.includes(":=") && (line.includes("class") || line.includes("struct") || line.includes("module") || line.includes("interface") || line.includes("enum"))) {
                    continue;
                }

                if (/\([^)]*\)\s*(?:<[^>]+>)?\s*:/.test(line)) {
                    continue;
                }

                const fullPath = currentModulePath ? `${currentModulePath}.${name}` : name;

                nodes.push({
                    name,
                    fullPath,
                    type: "variable",
                    isPublic,
                    sourceFile: filePath,
                    sourceLine: i + 1,
                });
            }
        }

        return nodes;
    }
}
