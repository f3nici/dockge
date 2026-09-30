import { describe, it, expect } from "vitest";
import { CommandHistory, MAX_HISTORY_ENTRIES } from "../common/command-history";

describe("CommandHistory", () => {
    it("has nothing to step back to before anything was run", () => {
        const history = new CommandHistory();
        expect(history.previous("")).toBeUndefined();
        expect(history.next()).toBeUndefined();
    });

    it("steps back through commands newest first, and stops at the oldest", () => {
        const history = new CommandHistory();
        history.add("ls");
        history.add("docker ps");

        expect(history.previous("")).toBe("docker ps");
        expect(history.previous("docker ps")).toBe("ls");
        expect(history.previous("ls")).toBeUndefined();
    });

    it("brings back the line being typed after stepping forward past the newest", () => {
        const history = new CommandHistory();
        history.add("ls");
        history.add("docker ps");

        expect(history.previous("half typ")).toBe("docker ps");
        expect(history.previous("docker ps")).toBe("ls");
        expect(history.next()).toBe("docker ps");
        expect(history.next()).toBe("half typ");
        expect(history.next()).toBeUndefined();
    });

    it("starts from the newest again once a command is run", () => {
        const history = new CommandHistory();
        history.add("ls");
        history.add("pwd");
        history.previous("");
        history.previous("pwd");
        history.add("ls");

        expect(history.previous("")).toBe("ls");
        expect(history.previous("ls")).toBe("pwd");
    });

    it("skips blank commands and immediate repeats", () => {
        const history = new CommandHistory();
        history.add("ls");
        history.add("ls");
        history.add("   ");
        history.add("");

        expect(history.previous("")).toBe("ls");
        expect(history.previous("ls")).toBeUndefined();
    });

    it("forgets the draft on reset", () => {
        const history = new CommandHistory();
        history.add("ls");
        history.previous("draft");
        history.reset();

        expect(history.next()).toBeUndefined();
        expect(history.previous("")).toBe("ls");
        expect(history.next()).toBe("");
    });

    it("keeps only the most recent commands", () => {
        const history = new CommandHistory();
        for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
            history.add("echo " + i);
        }

        let oldest : string | undefined;
        let count = 0;
        for (let entry = history.previous(""); entry !== undefined; entry = history.previous(entry)) {
            oldest = entry;
            count++;
        }

        expect(count).toBe(MAX_HISTORY_ENTRIES);
        expect(oldest).toBe("echo 10");
    });
});
