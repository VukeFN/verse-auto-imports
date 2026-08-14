import { classifyLines, LINE_SPLIT, ScannedImport, scanModuleImports } from "./ImportScanner";

/**
 * A text edit queued for the document, with no dependency on `vscode`.
 *
 * Positions are 0-based and carry the same meaning `vscode.Range` gives them,
 * so a range reaching character 0 of a line stops above that line. An edit
 * whose start and end coincide is an insertion and removes nothing.
 */
export interface QueuedEdit {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
}

/** Every line index an import statement covers, its own span only. */
function importSpanLines(imports: readonly ScannedImport[]): Set<number> {
    const covered = new Set<number>();
    for (const imp of imports) {
        for (let line = imp.startLine; line <= imp.endLine; line++) {
            covered.add(line);
        }
    }
    return covered;
}

/** A line of code outside the imports, with the line it was read from. */
interface BodyLine {
    text: string;
    /** 0-based, in the text this line was read from. */
    line: number;
}

/**
 * The lines carrying code that is not part of any import statement.
 *
 * Comment and blank lines are left out because a rewrite is allowed to move or
 * drop them: the comments written for a withheld import are deliberately
 * deleted with it, and the blank lines a hoisted block leaves behind are
 * trimmed. Lines inside an import span are left out because a rewrite re-emits
 * them from the path, so their text legitimately changes.
 *
 * What remains is the text no import rewrite has any business touching.
 */
function bodyLines(lines: string[]): BodyLine[] {
    const classifications = classifyLines(lines);
    const inImportSpan = importSpanLines(scanModuleImports(lines));

    const body: BodyLine[] = [];
    for (let line = 0; line < lines.length; line++) {
        if (classifications[line].kind === "code" && !inImportSpan.has(line)) {
            body.push({ text: lines[line], line });
        }
    }
    return body;
}

/**
 * Where two body-line sequences first disagree, or null when they match.
 *
 * Line numbers in the message are the input document's, not positions in the
 * filtered sequence: this string is the whole of what a maintainer gets when
 * the guard fires in the field, and a number that looks like a line number but
 * is not sends them to the wrong line.
 */
function firstBodyDifference(before: BodyLine[], after: BodyLine[]): string | null {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index++) {
        if (before[index].text !== after[index].text) {
            return `line ${before[index].line + 1} became ${JSON.stringify(after[index].text)}, was ${JSON.stringify(before[index].text)}`;
        }
    }

    if (before.length > after.length) {
        return `${before.length - after.length} code line(s) were lost, from line ${before[shared].line + 1}: ${JSON.stringify(before[shared].text)}`;
    }
    if (after.length > before.length) {
        return `${after.length - before.length} code line(s) appeared, from ${JSON.stringify(after[shared].text)}`;
    }
    return null;
}

/**
 * The reason a rebuilt document must not be applied over `before`, or null when
 * it is safe to apply.
 *
 * The organize path replaces the whole document, so a composition bug in the
 * rebuild - a body line claimed twice, a hoisted line never re-emitted, an
 * off-by-one in the partition - reaches the file as silent text loss. Reading
 * the rebuilt text back turns that class into a refused edit.
 *
 * Both texts are read through the same scanner, so this answers whether the
 * writer and the scanner agree, not whether either is right about Verse: a bug
 * inside scanModuleImports is invisible here, because both sides read it the
 * same wrong way.
 *
 * @param requestedPaths The additional paths the caller asked for. Only these
 *   may appear in `after` without appearing in `before`.
 */
export function verifyOrganizedRewrite(before: string, after: string, requestedPaths: readonly string[]): string | null {
    const beforeLines = before.split(LINE_SPLIT);
    const afterLines = after.split(LINE_SPLIT);

    const beforePaths = new Set(scanModuleImports(beforeLines).map((imp) => imp.path));
    const afterPaths = new Set(scanModuleImports(afterLines).map((imp) => imp.path));

    const lost = [...beforePaths].filter((path) => !afterPaths.has(path));
    if (lost.length > 0) {
        return `the rebuilt document no longer imports ${lost.join(", ")}`;
    }

    // Trimmed as buildOrganizedContent trims them, or a caller's untrimmed path
    // reads as one the rebuild invented.
    const allowed = new Set([...beforePaths, ...requestedPaths.map((path) => path.trim())]);
    const invented = [...afterPaths].filter((path) => !allowed.has(path));
    if (invented.length > 0) {
        return `the rebuilt document imports ${invented.join(", ")}, which nothing asked for`;
    }

    return firstBodyDifference(bodyLines(beforeLines), bodyLines(afterLines));
}

/** Whether the edit writes text in without taking any away. */
function isInsertion(edit: QueuedEdit): boolean {
    return edit.startLine === edit.endLine && edit.startCharacter === edit.endCharacter;
}

/**
 * Every line index the edits delete or overwrite.
 *
 * A line an edit only partly covers counts as removed: the part it takes is
 * text loss just the same, and no writer here produces such a range, so
 * counting it costs nothing.
 */
function removedLines(edits: readonly QueuedEdit[]): Set<number> {
    const removed = new Set<number>();
    for (const edit of edits) {
        if (isInsertion(edit)) {
            continue;
        }

        for (let line = edit.startLine; line <= edit.endLine; line++) {
            // The range stops above a line it reaches at character 0.
            if (line === edit.endLine && edit.endCharacter === 0) {
                continue;
            }
            removed.add(line);
        }
    }
    return removed;
}

/**
 * The reason a set of queued edits must not be applied to `lines`, or null when
 * they are safe to apply.
 *
 * The add path never builds one output text, so there is nothing to read back:
 * the edits themselves are what gets checked. Everything it removes should be an
 * import statement it writes again somewhere else, which is what the two
 * questions below ask.
 *
 * Read from the edits actually queued rather than from a record kept while
 * building them, so this answers for what will be applied rather than for what
 * was meant. It carries the same limitation as verifyOrganizedRewrite: the
 * scanner decides what counts as an import on both sides.
 *
 * @param intendedPaths The paths the caller decided to add. Only these may be
 *   written in that the document does not already import.
 */
export function verifyImportEdits(lines: string[], edits: readonly QueuedEdit[], intendedPaths: Iterable<string>): string | null {
    const classifications = classifyLines(lines);
    const imports = scanModuleImports(lines);
    const inImportSpan = importSpanLines(imports);
    const removed = removedLines(edits);

    // An insertion takes no text away, but one landing in the middle of a line
    // splices its statement onto whatever is already there and leaves one
    // unreadable line where two belong. Writing past the last line is the
    // legitimate reason to start anywhere but column 0, and that text opens
    // with the line break that keeps the two apart. See insertImportLines.
    for (const edit of edits) {
        if (isInsertion(edit) && edit.startCharacter !== 0 && !/^\r?\n/.test(edit.newText)) {
            return `the queued edits splice ${JSON.stringify(edit.newText)} into the middle of line ${edit.startLine + 1}`;
        }
    }

    for (const line of [...removed].sort((a, b) => a - b)) {
        // A position past the end is one VS Code clamps; no line of the
        // document is under it.
        if (line >= lines.length) {
            continue;
        }

        if (classifications[line].kind === "code" && !inImportSpan.has(line)) {
            return `the queued edits remove line ${line + 1}, which is code rather than an import: ${JSON.stringify(lines[line])}`;
        }
    }

    const written = new Set<string>();
    for (const edit of edits) {
        for (const imp of scanModuleImports(edit.newText.split(LINE_SPLIT))) {
            written.add(imp.path);
        }
    }

    const existingPaths = new Set(imports.map((imp) => imp.path));
    const allowed = new Set([...existingPaths, ...intendedPaths]);
    const invented = [...written].filter((path) => !allowed.has(path));
    if (invented.length > 0) {
        return `the queued edits import ${invented.join(", ")}, which nothing asked for`;
    }

    const surviving = new Set(written);
    // A path written on two lines survives while either is left alone, so the
    // question is asked per statement rather than per path.
    for (const imp of imports) {
        let spanRemoved = true;
        for (let line = imp.startLine; line <= imp.endLine && spanRemoved; line++) {
            spanRemoved = removed.has(line);
        }
        if (!spanRemoved) {
            surviving.add(imp.path);
        }
    }

    const dropped = [...existingPaths].filter((path) => !surviving.has(path));
    if (dropped.length > 0) {
        return `the queued edits remove ${dropped.join(", ")} without writing it back`;
    }

    return null;
}
