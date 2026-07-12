#!/usr/bin/env node
/**
 * Build-time script to parse .verse digest files into JSON.
 * This pre-compiles the digest files so they can be loaded quickly at runtime
 * without parsing the raw .verse files each time.
 *
 * Run with: npx ts-node src/scripts/parseDigestFiles.ts
 * Or via npm: npm run parse-digest
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
 * Extract the build reference from the digest file content.
 * Looks for patterns like: ++Fortnite+Release-37.20-CL-45679054
 */
function extractBuildReference(content: string): string {
    const buildMatch = content.match(/\+\+Fortnite\+Release-[\d.]+-CL-\d+/);
    return buildMatch ? buildMatch[0] : "unknown";
}

/**
 * Parse a single digest file into structured data.
 * The parsing logic is shared with the runtime path via `parseDigestContent`.
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

/**
 * Main function to parse all digest files
 */
function main() {
    const scriptDir = __dirname;
    const srcDir = path.resolve(scriptDir, "..");
    const utilsDir = path.join(srcDir, "utils");
    const dataDir = path.join(srcDir, "data");

    console.log("Parsing Verse digest files...");
    console.log(`  Source: ${utilsDir}`);
    console.log(`  Output: ${dataDir}`);
    console.log("");

    // Ensure data directory exists
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
