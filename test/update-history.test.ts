import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import {
    collectHistory,
    HistorySource,
    MAX_HISTORY_ENTRIES,
    MAX_HISTORY_PAGE,
    mergeHistoryPages,
    normalizeHistoryFilter,
    OutputRecorder,
    tidyOutput,
    trimOutput,
} from "../backend/update-history";
import { UpdateHistoryEntry, UpdateHistoryFilter, UpdateHistoryPage } from "../common/types";

/**
 * An entry as an instance sends it.
 * @param id ID
 * @param startedAt When it started
 * @param stackName The stack
 */
function entry(id : number, startedAt : string, stackName = "app") : UpdateHistoryEntry {
    return {
        id,
        stackName,
        serviceName: null,
        endpoint: "",
        triggerType: "manual",
        success: true,
        errorMessage: null,
        startedAt,
        completedAt: startedAt,
        durationMs: 1000,
    };
}

/**
 * A source holding these entries, newest first, that pages like the database.
 * @param endpoint Its endpoint
 * @param entries Its entries
 */
function source(endpoint : string, entries : UpdateHistoryEntry[]) : HistorySource & { asked : UpdateHistoryFilter[] } {
    const asked : UpdateHistoryFilter[] = [];
    return {
        endpoint,
        asked,
        fetch: async (filter) : Promise<UpdateHistoryPage> => {
            asked.push(filter);
            const offset = filter.offset ?? 0;
            return {
                entries: entries.slice(offset, offset + (filter.limit ?? 25)),
                total: entries.length,
            };
        },
    };
}

describe("normalizeHistoryFilter", () => {
    it("fills in a first page of 25", () => {
        expect(normalizeHistoryFilter(undefined)).toEqual({
            limit: 25,
            offset: 0,
        });
    });

    it("keeps paging within bounds", () => {
        expect(normalizeHistoryFilter({
            limit: 10000,
            offset: -5,
        })).toEqual({
            limit: MAX_HISTORY_PAGE,
            offset: 0,
        });
        expect(normalizeHistoryFilter({ limit: 0 }).limit).toBe(1);
        expect(normalizeHistoryFilter({ limit: 600 }, MAX_HISTORY_ENTRIES).limit).toBe(MAX_HISTORY_ENTRIES);
    });

    it("reads query string values", () => {
        expect(normalizeHistoryFilter({
            limit: "5",
            offset: "10",
            success: "false",
        })).toEqual({
            limit: 5,
            offset: 10,
            success: false,
        });
    });

    it("drops what it does not know", () => {
        expect(normalizeHistoryFilter({
            triggerType: "cron",
            stackName: 42,
            search: "  ",
            success: "maybe",
        })).toEqual({
            limit: 25,
            offset: 0,
        });
    });

    it("keeps a known trigger and the stack filters", () => {
        expect(normalizeHistoryFilter({
            triggerType: "api",
            stackName: "web",
            search: " we ",
            success: true,
        })).toEqual({
            limit: 25,
            offset: 0,
            triggerType: "api",
            stackName: "web",
            search: "we",
            success: true,
        });
    });
});

describe("mergeHistoryPages", () => {
    it("puts every instance's entries together newest first, with where they came from", () => {
        const merged = mergeHistoryPages([
            {
                endpoint: "",
                page: {
                    entries: [ entry(2, "2026-10-20T10:00:00.000Z"), entry(1, "2026-10-18T10:00:00.000Z") ],
                    total: 2,
                },
            },
            {
                endpoint: "agent:5001",
                page: {
                    entries: [ entry(7, "2026-10-19T10:00:00.000Z") ],
                    total: 1,
                },
            },
        ], 0, 10);

        expect(merged.total).toBe(3);
        expect(merged.entries.map((e) => [ e.endpoint, e.id ])).toEqual([
            [ "", 2 ],
            [ "agent:5001", 7 ],
            [ "", 1 ],
        ]);
    });

    it("returns the page asked for", () => {
        const merged = mergeHistoryPages([
            {
                endpoint: "",
                page: {
                    entries: [ entry(3, "2026-10-03T00:00:00.000Z"), entry(2, "2026-10-02T00:00:00.000Z"), entry(1, "2026-10-01T00:00:00.000Z") ],
                    total: 3,
                },
            },
        ], 1, 1);

        expect(merged.entries.map((e) => e.id)).toEqual([ 2 ]);
    });
});

describe("collectHistory", () => {
    it("lets a single instance page by itself", async () => {
        const local = source("", [ entry(2, "2026-10-02T00:00:00.000Z"), entry(1, "2026-10-01T00:00:00.000Z") ]);

        const page = await collectHistory([ local ], {
            limit: 1,
            offset: 1,
        });

        expect(local.asked).toHaveLength(1);
        expect(local.asked[0]).toEqual({
            limit: 1,
            offset: 1,
        });
        expect(page.entries.map((e) => e.id)).toEqual([ 1 ]);
        expect(page.total).toBe(2);
        expect(page.unreachable).toEqual([]);
    });

    it("finds the right page across several instances", async () => {
        // Interleaved by time: the second page of two must take from both
        const local = source("", [ entry(4, "2026-10-08T00:00:00.000Z"), entry(3, "2026-10-06T00:00:00.000Z"), entry(2, "2026-10-04T00:00:00.000Z"), entry(1, "2026-10-02T00:00:00.000Z") ]);
        const agent = source("agent:5001", [ entry(14, "2026-10-07T00:00:00.000Z"), entry(13, "2026-10-05T00:00:00.000Z"), entry(12, "2026-10-03T00:00:00.000Z"), entry(11, "2026-10-01T00:00:00.000Z") ]);

        const page = await collectHistory([ local, agent ], {
            limit: 2,
            offset: 2,
        });

        expect(page.entries.map((e) => `${e.endpoint}#${e.id}`)).toEqual([ "#3", "agent:5001#13" ]);
        expect(page.total).toBe(8);
        // Each is asked for everything up to the end of the page
        expect(local.asked[0]).toMatchObject({
            offset: 0,
            limit: 4,
        });
    });

    it("lists an instance that does not answer instead of failing", async () => {
        const local = source("", [ entry(1, "2026-10-01T00:00:00.000Z") ]);
        const offline : HistorySource = {
            endpoint: "offline:5001",
            fetch: async () => {
                throw new Error("not connected");
            },
        };

        const page = await collectHistory([ local, offline ], {});

        expect(page.entries).toHaveLength(1);
        expect(page.unreachable).toEqual([ "offline:5001" ]);
    });
});

describe("trimOutput", () => {
    it("leaves short output alone", () => {
        expect(trimOutput("done", 100)).toBe("done");
    });

    it("keeps the end of long output, where a failure says why", () => {
        const output = "x".repeat(500) + "Error: no space left on device";
        const trimmed = trimOutput(output, 100);

        expect(trimmed.length).toBe(100);
        expect(trimmed.startsWith("[... earlier output trimmed ...]\n")).toBe(true);
        expect(trimmed.endsWith("Error: no space left on device")).toBe(true);
    });
});

describe("tidyOutput", () => {
    it("drops the blank rows a terminal leaves behind", () => {
        expect(tidyOutput("\n\nPulling\n\n\n\nDone\n\n\n")).toBe("Pulling\n\nDone");
    });
});

describe("OutputRecorder", () => {
    it("keeps what a redrawn progress display finally showed, not every redraw", async () => {
        const recorder = new OutputRecorder(40, 8);

        recorder.write("docker compose pull\r\n");
        // Compose redraws its progress lines in place: up two lines, rewrite
        for (let percent = 0; percent <= 100; percent += 10) {
            if (percent > 0) {
                recorder.write("\x1b[2A");
            }
            recorder.write(`\r\x1b[2K web  Pulling ${percent}%\r\n`);
            recorder.write(`\r\x1b[2K db   Pulling ${percent}%\r\n`);
        }
        recorder.note("Update finished.");

        const text = await recorder.getText();

        expect(text).toBe("docker compose pull\n web  Pulling 100%\n db   Pulling 100%\n\nUpdate finished.");
    });

    it("joins a line the terminal wrapped back together", async () => {
        const recorder = new OutputRecorder(10, 8);

        recorder.write("0123456789abcdef\r\n");

        expect(await recorder.getText()).toBe("0123456789abcdef");
    });

    it("leaves out colours and other escape codes", async () => {
        const recorder = new OutputRecorder();

        recorder.write("\x1b[32mStarted\x1b[0m\r\n");

        expect(await recorder.getText()).toBe("Started");
    });
});
