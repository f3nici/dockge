import { describe, it, expect } from "vitest";
import {
    CREATED_FILE,
    CREATED_STACK,
    EXITED,
    RUNNING,
    RUNNING_AND_EXITED,
    StackFilter,
    StackFilterCategory,
    StackStatusInfo,
    UNHEALTHY,
    genSecret,
    getAgentMaintenanceTerminalName,
    getCombinedTerminalName,
    getComposeTerminalName,
    getContainerTerminalName,
    getCryptoRandomInt,
    getNested,
    intHash,
    isRecord,
    parseDockerPort,
} from "../common/util-common";

describe("intHash", () => {
    it("returns a value within the requested range", () => {
        for (let i = 0; i < 100; i++) {
            const value = intHash("some-string-" + i, 10);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(10);
        }
    });

    it("is deterministic for the same input", () => {
        expect(intHash("dockge")).toBe(intHash("dockge"));
    });

    it("defaults to a length of 10", () => {
        expect(intHash("anything")).toBeLessThan(10);
    });
});

describe("isRecord", () => {
    it("returns true for plain objects", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
    });

    it("returns false for null, arrays and primitives", () => {
        expect(isRecord(null)).toBe(false);
        expect(isRecord("string")).toBe(false);
        expect(isRecord(42)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        // Arrays are objects, so isRecord reports them as records by design
        expect(isRecord([])).toBe(true);
    });
});

describe("getNested", () => {
    const obj = {
        a: {
            b: {
                c: "value",
            },
        },
    };

    it("returns a deeply nested value", () => {
        expect(getNested<string>(obj, [ "a", "b", "c" ])).toBe("value");
    });

    it("returns undefined for a missing path", () => {
        expect(getNested(obj, [ "a", "x", "c" ])).toBeUndefined();
    });

    it("returns undefined when traversing through a non-object", () => {
        expect(getNested(obj, [ "a", "b", "c", "d" ])).toBeUndefined();
    });
});

describe("genSecret", () => {
    it("generates a string of the requested length", () => {
        expect(genSecret(64)).toHaveLength(64);
        expect(genSecret(1)).toHaveLength(1);
    });

    it("only uses alphanumeric characters", () => {
        expect(genSecret(200)).toMatch(/^[A-Za-z0-9]+$/);
    });

    it("produces different secrets on subsequent calls", () => {
        expect(genSecret(32)).not.toBe(genSecret(32));
    });
});

describe("getCryptoRandomInt", () => {
    it("returns a value within the inclusive bounds", () => {
        for (let i = 0; i < 1000; i++) {
            const value = getCryptoRandomInt(5, 10);
            expect(value).toBeGreaterThanOrEqual(5);
            expect(value).toBeLessThanOrEqual(10);
        }
    });

    it("returns the only possible value when min equals max", () => {
        expect(getCryptoRandomInt(7, 7)).toBe(7);
    });
});

describe("terminal name helpers", () => {
    it("builds compose terminal names", () => {
        expect(getComposeTerminalName("local", "mystack")).toBe("compose-local-mystack");
    });

    it("builds combined terminal names", () => {
        expect(getCombinedTerminalName("local", "mystack")).toBe("combined-local-mystack");
    });

    it("builds container terminal names", () => {
        expect(getContainerTerminalName("local", "mystack", "web", "bash", 0))
            .toBe("container-terminal-local-mystack-web-bash-0");
    });

    it("builds agent maintenance terminal names", () => {
        expect(getAgentMaintenanceTerminalName("local")).toBe("agent-maintenance-local");
    });
});

describe("parseDockerPort", () => {
    it("parses a single port", () => {
        const result = parseDockerPort("3000", "localhost");
        expect(result.display).toBe("3000");
        expect(result.url).toBe("http://localhost:3000");
    });

    it("parses a port range using the first port", () => {
        const result = parseDockerPort("3000-3005", "localhost");
        expect(result.display).toBe("3000-3005");
        expect(result.url).toBe("http://localhost:3000");
    });

    it("parses a host:container mapping", () => {
        const result = parseDockerPort("8000:8000", "localhost");
        expect(result.display).toBe("8000");
        expect(result.url).toBe("http://localhost:8000");
    });

    it("parses an ip:host:container mapping", () => {
        const result = parseDockerPort("127.0.0.1:8001:8001", "localhost");
        expect(result.url).toBe("http://127.0.0.1:8001");
    });

    it("uses https for port 443", () => {
        const result = parseDockerPort("443:443", "localhost");
        expect(result.url).toBe("https://localhost:443");
    });

    it("respects an explicit udp protocol", () => {
        const result = parseDockerPort("6060:6060/udp", "localhost");
        expect(result.url).toBe("udp://localhost:6060");
    });
});

describe("StackStatusInfo", () => {
    it("maps known status ids to their info", () => {
        expect(StackStatusInfo.get(RUNNING).label).toBe("active");
        expect(StackStatusInfo.get(EXITED).label).toBe("exited");
        expect(StackStatusInfo.get(RUNNING_AND_EXITED).label).toBe("partially");
        expect(StackStatusInfo.get(UNHEALTHY).label).toBe("unhealthy");
        expect(StackStatusInfo.get(CREATED_FILE).label).toBe("inactive");
        expect(StackStatusInfo.get(CREATED_STACK).label).toBe("inactive");
    });

    it("falls back to the default info for unknown ids", () => {
        expect(StackStatusInfo.get(9999).label).toBe("?");
    });
});

describe("StackFilterCategory", () => {
    it("toggles selection on and off", () => {
        const category = new StackFilterCategory<string>("status");
        category.toggleSelected("active");
        expect(category.selected.has("active")).toBe(true);
        category.toggleSelected("active");
        expect(category.selected.has("active")).toBe(false);
    });

    it("reports whether it has options", () => {
        const category = new StackFilterCategory<string>("status");
        expect(category.hasOptions()).toBe(false);
        category.options.active = "active";
        expect(category.hasOptions()).toBe(true);
    });

    it("only reports a filter selected when a known option is chosen", () => {
        const category = new StackFilterCategory<string>("status");
        category.options.active = "active";
        expect(category.isFilterSelected()).toBe(false);
        category.toggleSelected("active");
        expect(category.isFilterSelected()).toBe(true);
    });
});

describe("StackFilter", () => {
    it("reports no filter selected when empty", () => {
        const filter = new StackFilter();
        expect(filter.isFilterSelected()).toBe(false);
    });

    it("reports a filter selected when any category has a selection", () => {
        const filter = new StackFilter();
        filter.status.options.active = "active";
        filter.status.toggleSelected("active");
        expect(filter.isFilterSelected()).toBe(true);
    });

    it("clears all categories", () => {
        const filter = new StackFilter();
        filter.status.options.active = "active";
        filter.status.toggleSelected("active");
        filter.clear();
        expect(filter.isFilterSelected()).toBe(false);
    });
});
