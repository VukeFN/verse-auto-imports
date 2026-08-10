import * as fs from "fs";
import * as path from "path";
import { parseModuleVisibilityMessage } from "../ModuleVisibilityMessage";

/** The corpus entry with this id, so no compiler message is hand-written here. */
const corpusMessage = (id: string): string => {
    const corpusPath = path.join(__dirname, "..", "..", "..", "test-fixtures", "corpus", "41.10", "diagnostics.json");
    const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")) as { entries: { id: string; message: string }[] };
    const entry = corpus.entries.find((candidate) => candidate.id === id);
    if (!entry) {
        throw new Error(`No corpus entry '${id}'`);
    }
    return entry.message;
};

describe("parseModuleVisibilityMessage", () => {
    it("parses both paths out of the captured inaccessible-module message", () => {
        expect(parseModuleVisibilityMessage(corpusMessage("inaccessible-internal-module"))).toEqual({
            targetPath: "/vukefn@fortnite.com/VerseAutoImports/Gadgets/Tools",
            importerPath: "/vukefn@fortnite.com/VerseAutoImports/Scripts",
            moduleName: "Tools",
        });
    });

    it("ignores the sibling 3593 shape, which no <public> part fixes", () => {
        expect(parseModuleVisibilityMessage(corpusMessage("inaccessible-all-references"))).toBeNull();
    });

    it("accepts the help sentence with the specifier backticked", () => {
        const message =
            "Invalid access of internal module `(/mygame@fortnite.com/mygame/Gadgets:)Tools` from module `/mygame@fortnite.com/mygame/Scripts`. Consider setting the module's access specifier to `<public>` to make it accessible from other modules within your project.";

        expect(parseModuleVisibilityMessage(message)?.moduleName).toBe("Tools");
    });

    it("ignores an inaccessible definition that is not an internal module", () => {
        const message = "Invalid access of private function `(/mygame@fortnite.com/mygame/Gadgets:)Fire` from module `/mygame@fortnite.com/mygame/Scripts`.";

        expect(parseModuleVisibilityMessage(message)).toBeNull();
    });

    it("ignores an unrelated diagnostic", () => {
        expect(parseModuleVisibilityMessage("Unknown identifier `button_device`. Did you forget to specify using { /Fortnite.com/Devices }")).toBeNull();
    });

    it("reads a scope of any kind as the importer", () => {
        const message =
            "Invalid access of internal module `(/mygame@fortnite.com/mygame/Gadgets:)Tools` from class `/mygame@fortnite.com/mygame/Scripts/hud_device`. Consider setting the module's access specifier to <public> to make it accessible from other modules within your project.";

        expect(parseModuleVisibilityMessage(message)?.importerPath).toBe("/mygame@fortnite.com/mygame/Scripts/hud_device");
    });

    it("keeps a quoted suffix, which the module's path carries too", () => {
        const message =
            "Invalid access of internal module `(/mygame@fortnite.com/mygame/Gadgets:)Tools'v2'` from module `/mygame@fortnite.com/mygame/Scripts`. Consider setting the module's access specifier to <public> to make it accessible from other modules within your project.";

        expect(parseModuleVisibilityMessage(message)?.moduleName).toBe("Tools'v2'");
    });

    it("returns null when the help sentence is present but the paths are not", () => {
        expect(parseModuleVisibilityMessage("Consider setting the module's access specifier to <public> to make it accessible from other modules within your project.")).toBeNull();
    });
});
