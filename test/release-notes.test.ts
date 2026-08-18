import { describe, it, expect } from "vitest";
import { parseInline, parseReleaseNotes } from "../common/release-notes";

describe("parseInline", () => {
    it("returns a single text span for plain text", () => {
        expect(parseInline("Just some text")).toEqual([
            { type: "text",
                text: "Just some text" },
        ]);
    });

    it("parses bold, code and markdown links", () => {
        expect(parseInline("**bold** and `code` and [a link](https://example.com/x)")).toEqual([
            { type: "strong",
                text: "bold" },
            { type: "text",
                text: " and " },
            { type: "code",
                text: "code" },
            { type: "text",
                text: " and " },
            { type: "link",
                text: "a link",
                href: "https://example.com/x" },
        ]);
    });

    it("turns a bare URL into a link", () => {
        expect(parseInline("See https://github.com/f3nici/dockge/pull/12 for details")).toEqual([
            { type: "text",
                text: "See " },
            { type: "link",
                text: "https://github.com/f3nici/dockge/pull/12",
                href: "https://github.com/f3nici/dockge/pull/12" },
            { type: "text",
                text: " for details" },
        ]);
    });

    it("does not treat a javascript: URL as a link", () => {
        const spans = parseInline("[click](javascript:alert(1))");
        expect(spans.every((span) => span.type !== "link")).toBe(true);
    });

    it("leaves HTML as literal text rather than markup", () => {
        expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([
            { type: "text",
                text: "<img src=x onerror=alert(1)>" },
        ]);
    });

    it("does not carry regex state between calls", () => {
        const line = "**one** and **two**";
        expect(parseInline(line)).toEqual(parseInline(line));
    });
});

describe("parseReleaseNotes", () => {
    it("returns nothing for empty notes", () => {
        expect(parseReleaseNotes("")).toEqual([]);
    });

    it("parses headings", () => {
        expect(parseReleaseNotes("## What's Changed")).toEqual([
            { type: "heading",
                level: 2,
                spans: [{ type: "text",
                    text: "What's Changed" }] },
        ]);
    });

    it("gathers consecutive bullets into one list", () => {
        const blocks = parseReleaseNotes("* first\n* second\n- third");
        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe("list");
        expect(blocks[0].type === "list" && blocks[0].items).toHaveLength(3);
    });

    it("starts a new list after a blank line", () => {
        const blocks = parseReleaseNotes("- one\n\n- two");
        expect(blocks.map((b) => b.type)).toEqual([ "list", "list" ]);
    });

    it("makes each non-bullet line its own paragraph", () => {
        const blocks = parseReleaseNotes("first line\nsecond line");
        expect(blocks.map((b) => b.type)).toEqual([ "paragraph", "paragraph" ]);
    });

    it("closes an open list before a heading", () => {
        const blocks = parseReleaseNotes("- one\n## Next");
        expect(blocks.map((b) => b.type)).toEqual([ "list", "heading" ]);
    });

    it("drops HTML comments", () => {
        expect(parseReleaseNotes("<!-- hidden -->")).toEqual([]);
    });

    it("handles a realistic GitHub changelog", () => {
        const notes = [
            "## What's Changed",
            "* Fix the thing by @someone in https://github.com/f3nici/dockge/pull/44",
            "* Add **popups** for new versions",
            "",
            "**Full Changelog**: https://github.com/f3nici/dockge/compare/1.8.1...1.9.0",
        ].join("\n");

        const blocks = parseReleaseNotes(notes);
        expect(blocks.map((b) => b.type)).toEqual([ "heading", "list", "paragraph" ]);
        expect(blocks[1].type === "list" && blocks[1].items).toHaveLength(2);
    });

    it("ignores trailing whitespace and CRLF line endings", () => {
        const blocks = parseReleaseNotes("## Title  \r\n- one  \r\n");
        expect(blocks.map((b) => b.type)).toEqual([ "heading", "list" ]);
    });
});
