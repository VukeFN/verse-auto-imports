/**
 * Decides which modules on a target's path have to be declared `<public>` for
 * one importer to reach it. No VS Code dependencies.
 */

/** One segment of the target path, and whether it has to carry `<public>`. */
export interface VisibilitySegment {
    /** The module's own name. */
    name: string;

    /**
     * Whether this segment must be declared `<public>`. A false segment is
     * written only as the nesting a deeper declaration needs, and carries no
     * specifier of its own.
     */
    needsPublic: boolean;
}

/** The split of a target's path into the part already reachable and the part that is not. */
export interface VisibilityPlan {
    /** Content-relative segments the importer already reaches, outermost first. */
    prefix: string[];

    /** The segments below that, in root-to-target order. */
    segments: VisibilitySegment[];
}

/**
 * The Content-relative segments of a Verse path, or null when the path does not
 * sit under the project.
 *
 * @param versePath absolute, e.g. "/vukefn@fortnite.com/MyGame/Gadgets/Tools"
 * @param projectVersePath the project prefix exactly as UEFN wrote it, without a trailing slash
 */
export function toContentSegments(versePath: string, projectVersePath: string): string[] | null {
    const path = splitPath(versePath);
    const project = splitPath(projectVersePath);

    if (path.length < project.length) {
        return null;
    }
    for (let i = 0; i < project.length; i++) {
        if (path[i] !== project[i]) {
            return null;
        }
    }

    return path.slice(project.length);
}

/**
 * Which of the target's modules must become public for the importer to reach
 * it, given both paths relative to the Content root.
 *
 * `<internal>` grants access to the module a definition lives in and to every
 * child of that module. So a segment is reachable exactly when the importer
 * sits at or under the segment's PARENT. Walking the target path down from the
 * common prefix: the first divergent segment's parent is the common ancestor,
 * which the importer is under by construction, so that segment is already
 * reachable - only the ones below it are not. Marking it anyway compiles, but
 * publishes a module the importer never needed.
 *
 * `segments` is empty when the importer already sits inside the target's own
 * branch, which is a pair the compiler cannot have raised this error for.
 */
export function planVisibility(targetSegments: readonly string[], importerSegments: readonly string[]): VisibilityPlan {
    let common = 0;
    while (common < targetSegments.length && common < importerSegments.length && targetSegments[common] === importerSegments[common]) {
        common++;
    }

    if (common >= targetSegments.length) {
        return { prefix: [...targetSegments], segments: [] };
    }

    return {
        prefix: targetSegments.slice(0, common),
        segments: targetSegments.slice(common).map((name, index) => ({
            name,
            needsPublic: index > 0,
        })),
    };
}

/** Path segments with the leading slash and any empty segments dropped. */
function splitPath(path: string): string[] {
    return path.split("/").filter((segment) => segment.length > 0);
}
