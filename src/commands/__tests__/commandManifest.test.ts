import * as fs from "fs";
import * as path from "path";

// Regression for #136: six commands need caller-supplied arguments - the import
// quick fix passes them to addSingleImport, the CodeLens passes them to the four
// conversion commands, and the module-visibility quick fix passes the parsed
// diagnostic to makeModulePublic. Without a commandPalette entry hiding them,
// every declared command is palette-visible, and invoking one of these from the
// palette dereferences an undefined argument.

interface CommandContribution {
    command: string;
    title: string;
}

interface MenuContribution {
    command: string;
    when?: string;
}

interface Manifest {
    contributes: {
        commands: CommandContribution[];
        menus?: { commandPalette?: MenuContribution[] };
    };
}

const ARGUMENT_REQUIRING_COMMANDS = [
    "verseAutoImports.addSingleImport",
    "verseAutoImports.convertToFullPath",
    "verseAutoImports.convertAllToFullPath",
    "verseAutoImports.convertToRelativePath",
    "verseAutoImports.convertAllToRelativePath",
    "verseAutoImports.makeModulePublic",
];

const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"));

const commandPalette = manifest.contributes.menus?.commandPalette ?? [];

/** A palette entry hides its command only with a "when" that never holds. */
function isHiddenFromPalette(command: string): boolean {
    return commandPalette.some((entry) => entry.command === command && entry.when === "false");
}

describe("package.json commandPalette contributions", () => {
    it.each(ARGUMENT_REQUIRING_COMMANDS)("hides %s from the Command Palette", (command) => {
        expect(isHiddenFromPalette(command)).toBe(true);
    });

    it("hides no other command from the Command Palette", () => {
        const visible = manifest.contributes.commands.map((entry) => entry.command).filter((command) => !ARGUMENT_REQUIRING_COMMANDS.includes(command));

        for (const command of visible) {
            expect(isHiddenFromPalette(command)).toBe(false);
        }
    });

    it("declares no palette entry for a command that does not exist", () => {
        const declared = manifest.contributes.commands.map((entry) => entry.command);

        for (const entry of commandPalette) {
            expect(declared).toContain(entry.command);
        }
    });
});
