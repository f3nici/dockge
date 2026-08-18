import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settingsStore : Record<string, Record<string, unknown>> = {};

vi.mock("../backend/settings", () => ({
    Settings: {
        getSettings: vi.fn(async (type : string) => settingsStore[type] ?? {}),
        setSettings: vi.fn(async (type : string, data : Record<string, unknown>) => {
            settingsStore[type] = data;
        }),
    },
}));

vi.mock("../backend/log", () => ({
    log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { RegistryCredentialManager } from "../backend/registry-credentials";

const DOCKER_HUB_CONFIG_KEY = "https://index.docker.io/v1/";

function authOf(username : string, password : string) {
    return Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
}

describe("RegistryCredentialManager", () => {
    let dataDir : string;
    let manager : RegistryCredentialManager;
    const originalDockerConfig = process.env.DOCKER_CONFIG;

    beforeEach(async () => {
        vi.clearAllMocks();
        for (const key of Object.keys(settingsStore)) {
            delete settingsStore[key];
        }

        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-registry-"));
        delete process.env.DOCKER_CONFIG;

        manager = new RegistryCredentialManager();
        await manager.init(dataDir);
    });

    afterEach(() => {
        fs.rmSync(dataDir, {
            recursive: true,
            force: true,
        });

        if (originalDockerConfig === undefined) {
            delete process.env.DOCKER_CONFIG;
        } else {
            process.env.DOCKER_CONFIG = originalDockerConfig;
        }

        vi.unstubAllGlobals();
    });

    const configFile = () => path.join(dataDir, "docker-config", "config.json");
    const readConfig = () => JSON.parse(fs.readFileSync(configFile(), "utf-8"));

    describe("normalizeRegistry", () => {
        it("brings every spelling of Docker Hub to one entry", () => {
            for (const input of [ "docker.io", "DOCKER.IO", "https://index.docker.io/v1/", "registry-1.docker.io", " https://registry.hub.docker.com " ]) {
                expect(RegistryCredentialManager.normalizeRegistry(input)).toBe("docker.io");
            }
        });

        it("keeps other registries as their host name", () => {
            expect(RegistryCredentialManager.normalizeRegistry("https://ghcr.io/")).toBe("ghcr.io");
            expect(RegistryCredentialManager.normalizeRegistry("registry.example.com:5000")).toBe("registry.example.com:5000");
            expect(RegistryCredentialManager.normalizeRegistry("  ")).toBe("");
        });
    });

    describe("save", () => {
        it("writes both keys Docker Hub is looked up under", async () => {
            await manager.save([{
                registry: "https://index.docker.io/v1/",
                username: "user",
                password: "token",
            }]);

            const auths = readConfig().auths;
            expect(auths[DOCKER_HUB_CONFIG_KEY].auth).toBe(authOf("user", "token"));
            expect(auths["docker.io"].auth).toBe(authOf("user", "token"));
        });

        it("points the docker CLI and skopeo at the generated config", async () => {
            expect(manager.skopeoAuthArgs()).toEqual([]);

            await manager.save([{
                registry: "ghcr.io",
                username: "user",
                password: "token",
            }]);

            expect(process.env.DOCKER_CONFIG).toBe(path.join(dataDir, "docker-config"));
            expect(manager.skopeoAuthArgs()).toEqual([ "--authfile", configFile() ]);
        });

        it("keeps the stored password when none is sent back", async () => {
            await manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            await manager.save([{
                registry: "docker.io",
                username: "user2",
                password: "",
            }]);

            expect(readConfig().auths["docker.io"].auth).toBe(authOf("user2", "token"));
        });

        it("refuses an entry that has no password anywhere", async () => {
            await expect(manager.save([{
                registry: "ghcr.io",
                username: "user",
                password: "",
            }])).rejects.toThrow(/Password/);
        });

        it("refuses two entries for the same registry", async () => {
            await expect(manager.save([
                {
                    registry: "docker.io",
                    username: "a",
                    password: "1",
                },
                {
                    registry: "https://index.docker.io/v1/",
                    username: "b",
                    password: "2",
                },
            ])).rejects.toThrow(/Duplicate/);
        });

        it("steps out of the way again when the last login is removed", async () => {
            await manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            await manager.save([]);

            expect(fs.existsSync(configFile())).toBe(false);
            expect(process.env.DOCKER_CONFIG).toBeUndefined();
            expect(manager.skopeoAuthArgs()).toEqual([]);
        });

        it("carries over an existing docker config", async () => {
            const homeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-home-docker-"));
            fs.writeFileSync(path.join(homeConfigDir, "config.json"), JSON.stringify({
                auths: {
                    "quay.io": { auth: authOf("other", "secret") },
                },
                credsStore: "helper",
            }));

            process.env.DOCKER_CONFIG = homeConfigDir;
            const withBase = new RegistryCredentialManager();
            await withBase.init(dataDir);

            await withBase.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            const config = readConfig();
            expect(config.credsStore).toBe("helper");
            expect(config.auths["quay.io"].auth).toBe(authOf("other", "secret"));
            expect(config.auths["docker.io"].auth).toBe(authOf("user", "token"));

            fs.rmSync(homeConfigDir, {
                recursive: true,
                force: true,
            });
        });
    });

    describe("list", () => {
        it("never hands the passwords to the browser", async () => {
            await manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            expect(manager.list()).toEqual([{
                registry: "docker.io",
                username: "user",
            }]);
        });
    });

    describe("test", () => {
        it("reports the pull limit Docker Hub grants the account", async () => {
            const fetchMock = vi.fn(async (input : RequestInfo | URL, init? : RequestInit) => {
                const url = input.toString();

                if (url.startsWith("https://auth.docker.io/token")) {
                    expect(url).toContain("scope=repository%3Aratelimitpreview%2Ftest%3Apull");
                    expect((init?.headers as Record<string, string>).Authorization)
                        .toBe("Basic " + authOf("user", "token"));

                    return new Response(JSON.stringify({ token: "bearer-token" }), { status: 200 });
                }

                expect(init?.method).toBe("HEAD");
                return new Response(null, {
                    status: 200,
                    headers: {
                        "ratelimit-limit": "200;w=21600",
                        "ratelimit-remaining": "137;w=21600",
                    },
                });
            });
            vi.stubGlobal("fetch", fetchMock);

            const result = await manager.test("docker.io", "user", "token");

            expect(result.ok).toBe(true);
            expect(result.rateLimit).toEqual({
                limit: 200,
                remaining: 137,
                windowSeconds: 21600,
                authenticated: true,
                username: "user",
            });
        });

        it("reports no limit when Docker Hub sends no limit headers", async () => {
            vi.stubGlobal("fetch", vi.fn(async (input : RequestInfo | URL) => {
                if (input.toString().startsWith("https://auth.docker.io/token")) {
                    return new Response(JSON.stringify({ token: "bearer-token" }), { status: 200 });
                }
                return new Response(null, { status: 200 });
            }));

            const result = await manager.test("docker.io", "user", "token");

            expect(result.ok).toBe(true);
            expect(result.rateLimit?.limit).toBeNull();
            expect(result.rateLimit?.remaining).toBeNull();
        });

        it("says so when the credentials are rejected", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

            const result = await manager.test("docker.io", "user", "wrong");

            expect(result.ok).toBe(false);
            expect(result.msg).toContain("user");
        });

        it("falls back to a bearer token when a registry refuses Basic auth", async () => {
            const fetchMock = vi.fn(async (input : RequestInfo | URL) => {
                const url = input.toString();

                if (url === "https://ghcr.io/v2/") {
                    return new Response("", {
                        status: 401,
                        headers: {
                            "www-authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:user/app:pull\"",
                        },
                    });
                }

                return new Response(JSON.stringify({ token: "bearer-token" }), { status: 200 });
            });
            vi.stubGlobal("fetch", fetchMock);

            const result = await manager.test("ghcr.io", "user", "token");

            expect(result.ok).toBe(true);
            expect(fetchMock.mock.calls[1][0].toString()).toContain("https://ghcr.io/token");
        });

        it("uses the stored password when the browser sends none", async () => {
            await manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            const fetchMock = vi.fn(async (input : RequestInfo | URL, init? : RequestInit) => {
                if (input.toString().startsWith("https://auth.docker.io/token")) {
                    expect((init?.headers as Record<string, string>).Authorization)
                        .toBe("Basic " + authOf("user", "token"));
                    return new Response(JSON.stringify({ token: "bearer-token" }), { status: 200 });
                }
                return new Response(null, { status: 200 });
            });
            vi.stubGlobal("fetch", fetchMock);

            await expect(manager.test("docker.io", "user", "")).resolves.toMatchObject({ ok: true });
        });
    });

    describe("getDockerHubRateLimit", () => {
        it("checks anonymously when no Docker Hub login is stored", async () => {
            const fetchMock = vi.fn(async (input : RequestInfo | URL, init? : RequestInit) => {
                if (input.toString().startsWith("https://auth.docker.io/token")) {
                    expect((init?.headers as Record<string, string>)?.Authorization).toBeUndefined();
                    return new Response(JSON.stringify({ token: "bearer-token" }), { status: 200 });
                }
                return new Response(null, {
                    status: 200,
                    headers: {
                        "ratelimit-limit": "100;w=21600",
                        "ratelimit-remaining": "0;w=21600",
                    },
                });
            });
            vi.stubGlobal("fetch", fetchMock);

            const rateLimit = await manager.getDockerHubRateLimit();

            expect(rateLimit).toEqual({
                limit: 100,
                remaining: 0,
                windowSeconds: 21600,
                authenticated: false,
            });
        });
    });
});
