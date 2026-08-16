import { fileSystemFoldsCase, sameFsPath, sameFsSegment } from "../pathCasing";

const realPlatform = process.platform;

/** `process.platform` is read-only in the typings; redefining it is the seam the helper leaves for tests. */
const setPlatform = (platform: string): void => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
};

afterEach(() => setPlatform(realPlatform));

describe("pathCasing where the filesystem folds case", () => {
    beforeEach(() => setPlatform("win32"));

    it("reports the fold", () => {
        expect(fileSystemFoldsCase()).toBe(true);
    });

    it("treats two spellings of one segment as the same entry", () => {
        expect(sameFsSegment("Content", "content")).toBe(true);
    });

    it("treats two spellings of one path as the same file, whichever separators they carry", () => {
        expect(sameFsPath("C:\\Project\\Content\\_Definitions.verse", "C:/project/content/_definitions.verse")).toBe(true);
    });

    it("still tells two different names apart", () => {
        expect(sameFsSegment("Content", "Contents")).toBe(false);
    });
});

describe("pathCasing where the filesystem is byte-exact", () => {
    beforeEach(() => setPlatform("linux"));

    it("reports no fold", () => {
        expect(fileSystemFoldsCase()).toBe(false);
    });

    it("keeps two spellings of one name apart", () => {
        expect(sameFsSegment("Content", "content")).toBe(false);
        expect(sameFsPath("/repo/Content/_Definitions.verse", "/repo/Content/_definitions.verse")).toBe(false);
    });

    it("still matches an identical path across separators", () => {
        expect(sameFsPath("/repo\\Content/file.verse", "/repo/Content/file.verse")).toBe(true);
    });
});
