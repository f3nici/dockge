import { describe, it, expect } from "vitest";
import { LogFilter, stripAnsi } from "../common/log-filter";

describe("stripAnsi", () => {
    it("removes colour codes", () => {
        expect(stripAnsi("\u001B[31merror\u001B[0m here")).toBe("error here");
    });

    it("leaves plain text alone", () => {
        expect(stripAnsi("nginx started")).toBe("nginx started");
    });
});

describe("LogFilter", () => {
    it("hands output straight back when no filter is set", () => {
        const filter = new LogFilter();
        // Escape sequences and partial lines have to survive untouched, or an
        // ordinary terminal stops behaving like one
        expect(filter.write("\u001B[31mred\r\nno newline yet")).toBe("\u001B[31mred\r\nno newline yet");
    });

    it("shows only the matching lines once a filter is set", () => {
        const filter = new LogFilter();
        filter.write("alpha\nbravo\ncharlie\n");

        expect(filter.setFilter("bravo")).toBe("bravo\r\n");
        expect(filter.matchingLineCount).toBe(1);
    });

    it("puts everything back when the filter is cleared", () => {
        const filter = new LogFilter();
        filter.write("alpha\nbravo\n");
        filter.setFilter("bravo");

        expect(filter.setFilter("")).toBe("alpha\r\nbravo\r\n");
        expect(filter.matchingLineCount).toBe(2);
    });

    it("matches without regard to case", () => {
        const filter = new LogFilter();
        filter.write("Started NGINX\n");

        expect(filter.setFilter("nginx")).toBe("Started NGINX\r\n");
    });

    it("matches the text rather than the colour codes around it", () => {
        const filter = new LogFilter();
        filter.write("\u001B[31mfatal: disk full\u001B[0m\n");

        // The line is still written with its colours intact
        expect(filter.setFilter("disk full")).toBe("\u001B[31mfatal: disk full\u001B[0m\r\n");
    });

    it("does not match a filter against the escape sequence itself", () => {
        const filter = new LogFilter();
        filter.write("\u001B[31mred\n");

        expect(filter.setFilter("31m")).toBe("");
        expect(filter.matchingLineCount).toBe(0);
    });

    it("joins a line split across two chunks before matching it", () => {
        const filter = new LogFilter();
        filter.setFilter("keyword");

        // Neither half matches on its own
        expect(filter.write("first part with key")).toBe("");
        expect(filter.write("word in it\n")).toBe("first part with keyword in it\r\n");
    });

    it("holds a line back until it is complete", () => {
        const filter = new LogFilter();
        filter.setFilter("done");

        // A line that would match must still wait for its newline, or it would
        // be drawn twice once the rest arrives
        expect(filter.write("done but unfinished")).toBe("");
        expect(filter.write("\n")).toBe("done but unfinished\r\n");
    });

    it("counts every matching line as it arrives", () => {
        const filter = new LogFilter();
        filter.setFilter("hit");
        filter.write("hit one\nmiss\nhit two\n");

        expect(filter.matchingLineCount).toBe(2);
    });

    it("finds lines that arrived before the filter was typed", () => {
        const filter = new LogFilter();
        filter.write("earlier line\n");

        expect(filter.setFilter("earlier")).toBe("earlier line\r\n");
    });

    it("keeps a half-written line only while everything is shown", () => {
        const filter = new LogFilter();
        filter.write("complete\nhalf");

        expect(filter.redraw()).toBe("complete\r\nhalf");
        expect(filter.setFilter("complete")).toBe("complete\r\n");
    });

    it("drops the oldest lines once the buffer is full", () => {
        const filter = new LogFilter(3);
        filter.write("one\ntwo\nthree\nfour\n");

        expect(filter.setFilter("")).toBe("two\r\nthree\r\nfour\r\n");
    });

    it("forgets everything on clear", () => {
        const filter = new LogFilter();
        filter.write("alpha\n");
        filter.clear();

        expect(filter.redraw()).toBe("");
        expect(filter.matchingLineCount).toBe(0);
    });

    it("treats bare newlines and CRLF the same", () => {
        const filter = new LogFilter();
        filter.write("unix\ndos\r\n");

        expect(filter.setFilter("")).toBe("unix\r\ndos\r\n");
    });
});
