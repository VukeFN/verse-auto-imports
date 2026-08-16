import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/*
 * The status bar renders $(verse-imports-icon), which only draws something
 * when package.json contributes that id and the icon font maps the declared
 * character to a real outline. The mapping is the fragile link: the font is a
 * generated export whose start codepoint depends on the generator (IcoMoon
 * uses \e900, Fontello \e800), and a mismatch renders as an empty label with
 * no error anywhere. These tests parse the shipped font, so a regenerated
 * icon.woff whose codepoint drifted from the manifest fails here instead of
 * shipping blank.
 */

const repoRoot = path.join(__dirname, "..", "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

interface SfntTables {
    [tag: string]: Buffer;
}

function readWoffTables(file: string): SfntTables {
    const woff = fs.readFileSync(file);
    expect(woff.toString("ascii", 0, 4)).toBe("wOFF");

    const tables: SfntTables = {};
    const numTables = woff.readUInt16BE(12);
    for (let i = 0; i < numTables; i++) {
        const entry = 44 + i * 20;
        const tag = woff.toString("ascii", entry, entry + 4);
        const offset = woff.readUInt32BE(entry + 4);
        const compLength = woff.readUInt32BE(entry + 8);
        const origLength = woff.readUInt32BE(entry + 12);
        const raw = woff.subarray(offset, offset + compLength);
        tables[tag] = compLength < origLength ? zlib.inflateSync(raw) : Buffer.from(raw);
    }
    return tables;
}

function mapInFormat4Subtable(cmap: Buffer, subtable: number, codepoint: number): number | null {
    const segCountX2 = cmap.readUInt16BE(subtable + 6);
    const endBase = subtable + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;

    for (let seg = 0; seg < segCountX2 / 2; seg++) {
        const start = cmap.readUInt16BE(startBase + seg * 2);
        const end = cmap.readUInt16BE(endBase + seg * 2);
        if (codepoint < start || codepoint > end) continue;

        const rangeOffset = cmap.readUInt16BE(rangeBase + seg * 2);
        if (rangeOffset === 0) {
            return (codepoint + cmap.readInt16BE(deltaBase + seg * 2)) & 0xffff;
        }
        const glyphAt = rangeBase + seg * 2 + rangeOffset + (codepoint - start) * 2;
        const glyph = cmap.readUInt16BE(glyphAt);
        return glyph === 0 ? null : (glyph + cmap.readInt16BE(deltaBase + seg * 2)) & 0xffff;
    }
    return null;
}

/**
 * The glyph id a character maps to, or null when the font does not map it.
 * Consults every format-4 subtable, not only the first: which encoding record
 * comes first depends on the generator, the exact variable this file guards.
 */
function glyphIdFor(tables: SfntTables, codepoint: number): number | null {
    const cmap = tables["cmap"];
    const records = cmap.readUInt16BE(2);
    for (let i = 0; i < records; i++) {
        const subtable = cmap.readUInt32BE(4 + i * 8 + 4);
        if (cmap.readUInt16BE(subtable) !== 4) continue;

        const glyph = mapInFormat4Subtable(cmap, subtable, codepoint);
        if (glyph !== null) return glyph;
    }
    return null;
}

/**
 * Byte length of a glyph's outline data; 0 means the glyph draws nothing.
 * TrueType-flavored fonts only, which is what the icon-font generators emit.
 */
function outlineLength(tables: SfntTables, glyphId: number): number {
    const longFormat = tables["head"].readUInt16BE(50) === 1;
    const loca = tables["loca"];
    return longFormat ? loca.readUInt32BE((glyphId + 1) * 4) - loca.readUInt32BE(glyphId * 4) : (loca.readUInt16BE((glyphId + 1) * 2) - loca.readUInt16BE(glyphId * 2)) * 2;
}

function contourCount(tables: SfntTables, glyphId: number): number {
    const longFormat = tables["head"].readUInt16BE(50) === 1;
    const loca = tables["loca"];
    const offset = longFormat ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;
    return tables["glyf"].readInt16BE(offset);
}

describe("verse-imports-icon contribution", () => {
    const icon = manifest.contributes.icons["verse-imports-icon"];

    it("is contributed with a font path and character", () => {
        expect(icon).toBeDefined();
        expect(icon.default.fontPath).toBeDefined();
        expect(icon.default.fontCharacter).toMatch(/^\\[0-9a-f]+$/i);
    });

    it("maps the declared character to a drawn glyph in the shipped font", () => {
        const tables = readWoffTables(path.join(repoRoot, icon.default.fontPath));
        const codepoint = parseInt(icon.default.fontCharacter.slice(1), 16);

        const glyphId = glyphIdFor(tables, codepoint);
        expect(glyphId).not.toBeNull();
        expect(glyphId).not.toBe(0);
        expect(outlineLength(tables, glyphId as number)).toBeGreaterThan(0);
    });

    // The glyph is the arrow plus a V carved into two pieces by the gap
    // around the arrow. A regeneration that collapses the count back to two
    // has lost the carve; a deliberate redesign updates this pin with it.
    it("keeps the carved gap that separates the arrow from the V", () => {
        const tables = readWoffTables(path.join(repoRoot, icon.default.fontPath));
        const codepoint = parseInt(icon.default.fontCharacter.slice(1), 16);

        expect(contourCount(tables, glyphIdFor(tables, codepoint) as number)).toBe(3);
    });
});
