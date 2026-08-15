import * as fs from "fs";
import * as path from "path";

/**
 * Only `deprecationMessage` makes VS Code hide a setting from the settings
 * editor and flag an existing value; a deprecation written into `description`
 * leaves the key listed as a live setting.
 */
describe("deprecated configuration properties", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    const registered: Record<string, { description?: string; deprecationMessage?: string }> = manifest.contributes.configuration.properties;

    /** Keys the manifest still contributes for backward compatibility only. */
    const DEPRECATED = ["verseAutoImports.general.diagnosticDelay"];

    it.each(DEPRECATED)("declares %s deprecated through deprecationMessage", (key) => {
        expect(registered[key]?.deprecationMessage).toEqual(expect.stringContaining("autoImportDebounceDelay"));
    });

    // The marker shape rather than the word: a description may legitimately
    // mention a deprecation it is not itself carrying.
    it("carries no prose deprecation marker in any description", () => {
        const inProse = Object.entries(registered)
            .filter(([, property]) => /^\s*\[deprecated/i.test(property.description ?? ""))
            .map(([key]) => key);

        expect(inProse).toEqual([]);
    });
});
