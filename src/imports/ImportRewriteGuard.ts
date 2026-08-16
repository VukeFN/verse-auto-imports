import { classifyLines, LINE_SPLIT, ScannedImport, scanModuleImports } from "./ImportScanner";

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
 * Every writer rebuilds the document as one target text, so a composition bug
 * in a rebuild - a body line claimed twice, a hoisted line never re-emitted,
 * an off-by-one in a splice - reaches the file as silent text loss. Reading
 * the rebuilt text back turns that class into a refused edit, on the add path
 * and the organize path alike.
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
