/**
 * The one case rule for comparing filesystem names, shared so no two
 * components can disagree about whether two spellings are one path.
 *
 * These comparisons are for names the filesystem resolves - the Content
 * folder, a configured file name matched against a directory listing. Names
 * the Verse compiler resolves are module names, compared byte-exact
 * everywhere; folding one of those would name the wrong module.
 */

/**
 * Whether this platform's filesystem treats two spellings of one name as the
 * same entry. Read at call time rather than bound at load, so a test can pin
 * the platform it exercises.
 */
export function fileSystemFoldsCase(): boolean {
    return process.platform === "win32";
}

/**
 * Whether two path segments name the same directory entry under the
 * platform's case rule: folded where the filesystem folds, byte-exact where
 * it does not. The fold is the one `path.win32.relative` applies, so a
 * comparison made here cannot disagree with a placement made through
 * `path.relative`.
 */
export function sameFsSegment(a: string, b: string): boolean {
    return fileSystemFoldsCase() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether two paths address the same file under the platform's case rule,
 * whichever separators they carry. The comparison is textual after separator
 * normalization - `.` and `..` are not resolved - which serves callers
 * passing `Uri.fsPath` values, where neither occurs.
 */
export function sameFsPath(a: string, b: string): boolean {
    const normalize = (candidate: string): string => candidate.replace(/\\/g, "/");
    return fileSystemFoldsCase() ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}
