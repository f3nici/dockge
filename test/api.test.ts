import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("redbean-node", () => ({
    R: {
        knex: vi.fn(() => ({
            where: () => ({
                first: async () => undefined,
            }),
        })),
    },
}));

import { ApiError, errorStatus, parsePolicy, policyName, resolveEndpoint, stackView } from "../backend/api-views";
import { ApiKeys, generateApiKey, hashApiKey } from "../backend/api-keys";
import { ValidationError } from "../backend/util-server";
import { SelfStackError } from "../backend/self-stack";
import { AgentTimeoutError } from "../backend/agent-manager";
import { RUNNING, EXITED } from "../common/util-common";
import { ServiceData, SimpleStackData } from "../common/types";

/**
 * A stack as Dockge sends it to the browser.
 * @param overrides What differs from a running, managed stack
 */
function simpleStack(overrides : Partial<SimpleStackData> = {}) : SimpleStackData {
    return {
        name: "web",
        status: RUNNING,
        started: true,
        recreateNecessary: false,
        imageUpdatesAvailable: false,
        tags: [],
        autoUpdate: null,
        isManagedByDockge: true,
        composeFileName: "compose.yaml",
        endpoint: "",
        ...overrides,
    };
}

const service : ServiceData = {
    name: "nginx",
    containerName: "web-nginx-1",
    image: "nginx:latest",
    state: "running",
    status: "Up 2 hours",
    health: "",
    recreateNecessary: false,
    imageUpdateAvailable: true,
    remoteImageDigest: "sha256:abc",
};

describe("stackView", () => {
    it("sends a stack the way the Home Assistant integration reads it", () => {
        const view = stackView(simpleStack({ imageUpdatesAvailable: true }), { nginx: service }, "agent:5001", "none");

        expect(view).toEqual({
            name: "web",
            status: "running",
            statusCode: RUNNING,
            started: true,
            isManagedByDockge: true,
            endpoint: "agent:5001",
            autoUpdate: false,
            autoUpdatePolicy: "inherit",
            imageUpdatesAvailable: true,
            recreateNecessary: false,
            tags: [],
            services: {
                nginx: {
                    name: "nginx",
                    containerName: "web-nginx-1",
                    image: "nginx:latest",
                    state: "running",
                    status: "Up 2 hours",
                    health: "",
                    imageUpdateAvailable: true,
                    recreateNecessary: false,
                },
            },
        });
    });

    it("works out whether auto update will update the stack", () => {
        expect(stackView(simpleStack({ autoUpdate: null }), {}, "", "update").autoUpdate).toBe(true);
        expect(stackView(simpleStack({ autoUpdate: false }), {}, "", "update").autoUpdate).toBe(false);
        expect(stackView(simpleStack({ autoUpdate: true }), {}, "", "none").autoUpdate).toBe(true);
        // Auto update only ever touches stacks Dockge manages
        expect(stackView(simpleStack({ isManagedByDockge: false }), {}, "", "update").autoUpdate).toBe(false);
    });

    it("names the status", () => {
        expect(stackView(simpleStack({ status: EXITED }), {}, "", "none").status).toBe("exited");
        expect(stackView(simpleStack({ status: 99 }), {}, "", "none").status).toBe("unknown");
    });
});

describe("parsePolicy", () => {
    it("takes the switch Home Assistant sends", () => {
        expect(parsePolicy({ enabled: true })).toBe(true);
        expect(parsePolicy({ enabled: false })).toBe(false);
        expect(parsePolicy({ enabled: null })).toBe(null);
    });

    it("takes a policy by name", () => {
        expect(parsePolicy({ policy: "always" })).toBe(true);
        expect(parsePolicy({ policy: "never" })).toBe(false);
        expect(parsePolicy({ policy: "inherit" })).toBe(null);
    });

    it("refuses anything else", () => {
        expect(() => parsePolicy({ enabled: "yes" })).toThrow(ValidationError);
        expect(() => parsePolicy({ policy: "sometimes" })).toThrow(ValidationError);
        expect(() => parsePolicy(undefined)).toThrow(ValidationError);
    });

    it("round-trips with policyName", () => {
        for (const name of [ "always", "never", "inherit" ] as const) {
            expect(policyName(parsePolicy({ policy: name }))).toBe(name);
        }
    });
});

describe("resolveEndpoint", () => {
    const agents = [
        {
            endpoint: "",
            name: "Home",
        },
        {
            endpoint: "192.168.1.20:5001",
            name: "Voltorb",
        },
    ];

    it("takes an endpoint as it is", () => {
        expect(resolveEndpoint("192.168.1.20:5001", agents)).toBe("192.168.1.20:5001");
        expect(resolveEndpoint("", agents)).toBe("");
    });

    it("takes an agent's name, whatever its case", () => {
        expect(resolveEndpoint("voltorb", agents)).toBe("192.168.1.20:5001");
        expect(resolveEndpoint("home", agents)).toBe("");
        expect(resolveEndpoint("master", agents)).toBe("");
    });

    it("finds nothing for an agent that is not there", () => {
        expect(resolveEndpoint("10.0.0.1:5001", agents)).toBeUndefined();
        expect(resolveEndpoint("Pikachu", agents)).toBeUndefined();
    });
});

describe("errorStatus", () => {
    it("maps what went wrong to an HTTP status", () => {
        expect(errorStatus(new ApiError(418, "teapot"))).toBe(418);
        expect(errorStatus(new ValidationError("Stack not found"))).toBe(404);
        expect(errorStatus(new ValidationError("Invalid stack name"))).toBe(400);
        expect(errorStatus(new SelfStackError("Dockge runs in it"))).toBe(409);
        expect(errorStatus(new AgentTimeoutError("no answer"))).toBe(504);
        expect(errorStatus(new Error("Another operation is already running, please try again later."))).toBe(409);
        expect(errorStatus(new Error("boom"))).toBe(500);
    });
});

describe("API keys", () => {
    afterEach(() => {
        delete process.env.DOCKGE_API_KEY;
    });

    it("are long, random, and recognisable", () => {
        const a = generateApiKey();
        const b = generateApiKey();

        expect(a).toMatch(/^dk_[A-Za-z0-9_-]{43}$/);
        expect(a).not.toBe(b);
    });

    it("are stored as a SHA-256 hash", () => {
        // printf %s dk_test | sha256sum
        expect(hashApiKey("dk_test")).toBe("c7227eeed0fef371f9acff96fbd4943211a10a4f41642d172f133acc9963c96b");
    });

    it("accept the key in DOCKGE_API_KEY with full access", async () => {
        process.env.DOCKGE_API_KEY = "from-the-environment";

        expect(await ApiKeys.verify("from-the-environment")).toEqual({
            id: null,
            name: "DOCKGE_API_KEY",
            readOnly: false,
        });
    });

    it("refuse anything else", async () => {
        process.env.DOCKGE_API_KEY = "from-the-environment";

        expect(await ApiKeys.verify("from-the-environmenT")).toBeNull();
        expect(await ApiKeys.verify("")).toBeNull();
    });

    it("refuse a name that is empty or too long", async () => {
        await expect(ApiKeys.create("  ", false)).rejects.toThrow(ValidationError);
        await expect(ApiKeys.create("x".repeat(65), false)).rejects.toThrow(ValidationError);
        await expect(ApiKeys.create("ok", "yes")).rejects.toThrow(ValidationError);
    });
});
