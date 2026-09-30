/**
 * Which variables a compose file interpolates, and whether the stack's .env
 * actually defines them.
 *
 * Docker compose substitutes an undefined variable with an empty string and
 * carries on, so a typo in a name turns into an image tag or a port that is
 * quietly blank. Telling the two apart in the editor is the point of this.
 */

/** `NAME=`, optionally exported, ignoring comments and blank lines */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** `${NAME`, or the `$NAME` shorthand, at the start of a token */
const VARIABLE_NAME = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * `${NAME-default}` and `${NAME:-default}` stand in for a value of their own, so
 * the variable being undefined is not a problem. `?` is the opposite: it makes
 * compose fail outright, so it is left to be reported.
 */
const HAS_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-/;

/**
 * The variable names a .env file defines.
 * @param env Contents of the .env file
 * @returns The names defined in it
 */
export function definedVariableNames(env : string) : Set<string> {
    const names = new Set<string>();

    for (const line of (env ?? "").split("\n")) {
        const trimmed = line.trim();

        if (trimmed === "" || trimmed.startsWith("#")) {
            continue;
        }

        const match = ASSIGNMENT.exec(line);
        if (match) {
            names.add(match[1]);
        }
    }

    return names;
}

/**
 * Whether an interpolation would be substituted with nothing.
 * @param token One `${NAME}` or `$NAME` as it appears in the compose file
 * @param defined The names the .env defines
 * @returns true when the variable is undefined and has no default to fall back on
 */
export function isUnresolvedVariable(token : string, defined : Set<string>) : boolean {
    const match = VARIABLE_NAME.exec(token);

    // Not a name at all, so there is nothing to report: `${}` and the like are
    // the YAML's problem, not ours
    if (!match) {
        return false;
    }

    if (defined.has(match[1])) {
        return false;
    }

    return !HAS_DEFAULT.test(token);
}
