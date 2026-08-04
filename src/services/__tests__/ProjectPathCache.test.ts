import { ProjectPathCache } from "../ProjectPathCache";

/**
 * Regression tests for issue #95: the workspace-wide .verse watcher reaches the
 * external Assets.digest.verse in the UEFN multi-root workspace, and the file
 * change and delete handlers must ignore any *.digest.verse file so it never
 * enters the declaration cache. Both handlers gate on the pure isDigestFile
 * predicate, which is exercised here without the VS Code runtime.
 */
describe("ProjectPathCache.isDigestFile", () => {
    const fileUri = (fsPath: string): { fsPath: string } => ({ fsPath });

    it("ignores a *.digest.verse event so it never enters the cache", () => {
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\VerseProject\\P-Assets\\Assets.digest.verse"))).toBe(true);
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\VerseProject\\Fortnite\\Fortnite.digest.verse"))).toBe(true);
        expect(ProjectPathCache.isDigestFile(fileUri("/home/user/VerseProject/P-Assets/Assets.digest.verse"))).toBe(true);
    });

    it("still processes a regular project .verse event", () => {
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\Project\\Content\\Scripts\\device.verse"))).toBe(false);
        expect(ProjectPathCache.isDigestFile(fileUri("/home/user/Content/device.verse"))).toBe(false);
    });

    it("is case-insensitive about the digest extension", () => {
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\VerseProject\\P-Assets\\Assets.DIGEST.verse"))).toBe(true);
    });

    it("does not treat a name that merely contains 'digest' as a digest file", () => {
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\Project\\Content\\digest.verse"))).toBe(false);
        expect(ProjectPathCache.isDigestFile(fileUri("C:\\Project\\Content\\my_digest_helper.verse"))).toBe(false);
    });
});
