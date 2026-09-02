import { describe, it, expect } from "vitest";
import { definedVariableNames, isUnresolvedVariable } from "../common/compose-variables";

describe("definedVariableNames", () => {
    it("reads the names a .env defines", () => {
        const names = definedVariableNames("PUID=1000\nTZ=Europe/London\n");

        expect([ ...names ].sort()).toEqual([ "PUID", "TZ" ]);
    });

    it("ignores comments and blank lines", () => {
        const names = definedVariableNames("# TZ=Europe/London\n\n   \nPUID=1000\n");

        expect([ ...names ]).toEqual([ "PUID" ]);
    });

    it("accepts an exported assignment", () => {
        expect(definedVariableNames("export TOKEN=abc\n").has("TOKEN")).toBe(true);
    });

    it("accepts a name defined as empty", () => {
        // Compose treats it as set, so the editor must too
        expect(definedVariableNames("EMPTY=\n").has("EMPTY")).toBe(true);
    });

    it("tolerates whitespace around the name", () => {
        expect(definedVariableNames("  PUID = 1000\n").has("PUID")).toBe(true);
    });

    it("returns nothing for an empty file", () => {
        expect(definedVariableNames("").size).toBe(0);
    });
});

describe("isUnresolvedVariable", () => {
    const defined = new Set([ "PUID" ]);

    it("accepts a variable the .env defines", () => {
        expect(isUnresolvedVariable("${PUID}", defined)).toBe(false);
    });

    it("flags one it does not", () => {
        expect(isUnresolvedVariable("${MISSING}", defined)).toBe(true);
    });

    it("handles the $NAME shorthand both ways", () => {
        expect(isUnresolvedVariable("$PUID", defined)).toBe(false);
        expect(isUnresolvedVariable("$MISSING", defined)).toBe(true);
    });

    it("accepts an undefined variable that has a default", () => {
        // Compose substitutes the default, so there is nothing to warn about
        expect(isUnresolvedVariable("${MISSING:-nginx}", defined)).toBe(false);
        expect(isUnresolvedVariable("${MISSING-nginx}", defined)).toBe(false);
    });

    it("still flags one whose only fallback is an error", () => {
        // ${NAME:?msg} makes compose fail, which is worth showing
        expect(isUnresolvedVariable("${MISSING:?must be set}", defined)).toBe(true);
        expect(isUnresolvedVariable("${MISSING?must be set}", defined)).toBe(true);
    });

    it("leaves a token that names no variable alone", () => {
        expect(isUnresolvedVariable("${}", defined)).toBe(false);
        expect(isUnresolvedVariable("${1BAD}", defined)).toBe(false);
    });

    it("does not treat a longer name as a defined one", () => {
        expect(isUnresolvedVariable("${PUID_EXTRA}", defined)).toBe(true);
    });
});
