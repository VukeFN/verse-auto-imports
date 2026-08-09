#!/usr/bin/env node
/**
 * Precompiles the bundled `.verse` digests into JSON, so the runtime loads a
 * parsed index instead of parsing megabytes of Verse at activation.
 *
 * Run with `npm run parse-digest`. Its output under `src/data` is generated and
 * checked in: refresh it by replacing the `.verse` inputs and re-running, never
 * by editing the JSON.
 */

import * as fs from "fs";
import * as path from "path";
// Import the shared parser directly (not via the services barrel, which pulls in
// `vscode` and would break ts-node).
import { parseDigestContent, rootDomainForDigestFile } from "../services/digestParsing";

interface PrecompiledDigest {
    version: string;
    generatedAt: string;
    sourceFile: string;
    sourceBuild: string;
    entries: ReturnType<typeof parseDigestContent>["entries"];
    moduleIndex: ReturnType<typeof parseDigestContent>["moduleIndex"];
}

const DIGEST_FILES = ["Fortnite.digest.verse", "UnrealEngine.digest.verse", "Verse.digest.verse"];

const VERSION = "1.0.0";

/**
 * The UEFN build a digest came from, as stamped in its header
 * (`++Fortnite+Release-37.20-CL-45679054`), or "unknown" if absent.
 */
function extractBuildReference(content: string): string {
    const buildMatch = content.match(/\+\+Fortnite\+Release-[\d.]+-CL-\d+/);
    return buildMatch ? buildMatch[0] : "unknown";
}

/**
 * One digest file, parsed and stamped for storage. Parsing itself is shared
 * with the runtime path through `parseDigestContent`, so the precompiled data
 * cannot drift from what a live parse would produce.
 */
function parseDigestFile(filePath: string): PrecompiledDigest {
    const content = fs.readFileSync(filePath, "utf8");
    const fileName = path.basename(filePath);

    const { entries, moduleIndex } = parseDigestContent(content, rootDomainForDigestFile(fileName));

    return {
        version: VERSION,
        generatedAt: new Date().toISOString(),
        sourceFile: fileName,
        sourceBuild: extractBuildReference(content),
        entries,
        moduleIndex,
    };
}

function main() {
    const scriptDir = __dirname;
    const srcDir = path.resolve(scriptDir, "..");
    const utilsDir = path.join(srcDir, "utils");
    const dataDir = path.join(srcDir, "data");

    console.log("Parsing Verse digest files...");
    console.log(`  Source: ${utilsDir}`);
    console.log(`  Output: ${dataDir}`);
    console.log("");

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`Created directory: ${dataDir}`);
    }

    let totalEntries = 0;

    for (const digestFile of DIGEST_FILES) {
        const inputPath = path.join(utilsDir, digestFile);

        if (!fs.existsSync(inputPath)) {
            console.warn(`  Warning: ${digestFile} not found, skipping`);
            continue;
        }

        console.log(`  Parsing ${digestFile}...`);

        const digest = parseDigestFile(inputPath);
        const entryCount = Object.keys(digest.entries).length;
        const moduleCount = Object.keys(digest.moduleIndex).length;
        totalEntries += entryCount;

        const outputFile = digestFile.replace(".verse", ".json");
        const outputPath = path.join(dataDir, outputFile);

        fs.writeFileSync(outputPath, JSON.stringify(digest, null, 2));

        console.log(`    -> ${outputFile}`);
        console.log(`       ${entryCount} entries, ${moduleCount} modules`);
        console.log(`       Build: ${digest.sourceBuild}`);
    }

    console.log("");
    console.log(`Done! Total: ${totalEntries} entries parsed`);
}

main();
