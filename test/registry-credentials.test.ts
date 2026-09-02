import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const settingsStore : Record<string, Record<string, unknown>> = {};

vi.mock("../backend/settings", () => ({
    Settings: {
        getSettings: vi.fn(async (type : string) => settingsStore[type] ?? {}),
        // Throws on a conflict, so save() cannot report success for a write
        // that did not land and lose the logins at the next restart
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

    /**
     * Stand in for a docker config the user mounted themselves, and point
     * DOCKER_CONFIG at it.
     * @param config Contents of its config.json
     */
    function makeHomeConfig(config : Record<string, unknown>) : string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-home-docker-"));
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
        process.env.DOCKER_CONFIG = dir;
        return dir;
    }

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

        it("stops using the logins when the last one is removed", async () => {
            await manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            await manager.save([]);

            expect(readConfig().auths).toEqual({});
            expect(manager.skopeoAuthArgs()).toEqual([]);

            // DOCKER_CONFIG stays pointed at the writable directory even with no
            // logins left, or buildx goes back to writing to /root/.docker
            expect(process.env.DOCKER_CONFIG).toBe(path.join(dataDir, "docker-config"));
        });

        it("points docker at a writable config directory before any login exists", async () => {
            // buildx creates $DOCKER_CONFIG/buildx on every docker compose call,
            // which fails wherever /root/.docker is not writable
            expect(process.env.DOCKER_CONFIG).toBe(path.join(dataDir, "docker-config"));
            expect(fs.existsSync(configFile())).toBe(true);
            expect(manager.skopeoAuthArgs()).toEqual([]);
        });

        it("carries over a mounted docker config when there are no logins", async () => {
            const homeConfigDir = makeHomeConfig({
                auths: {
                    "quay.io": { auth: authOf("other", "secret") },
                },
                credsStore: "desktop",
            });

            const withBase = new RegistryCredentialManager();
            await withBase.init(dataDir);

            const config = readConfig();

            // The user's own auths still reach the docker CLI...
            expect(config.auths["quay.io"]).toEqual({ auth: authOf("other", "secret") });
            // ...and with no logins of ours to shadow, so does their helper
            expect(config.credsStore).toBe("desktop");

            fs.rmSync(homeConfigDir, {
                recursive: true,
                force: true,
            });
        });

        it("carries over an existing docker config", async () => {
            const homeConfigDir = makeHomeConfig({
                auths: {
                    "quay.io": { auth: authOf("other", "secret") },
                },
                psFormat: "table {{.ID}}",
            });

            const withBase = new RegistryCredentialManager();
            await withBase.init(dataDir);

            await withBase.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            const config = readConfig();
            expect(config.psFormat).toBe("table {{.ID}}");
            expect(config.auths["quay.io"].auth).toBe(authOf("other", "secret"));
            expect(config.auths["docker.io"].auth).toBe(authOf("user", "token"));

            fs.rmSync(homeConfigDir, {
                recursive: true,
                force: true,
            });
        });

        it("drops the credential helpers that would shadow the logins", async () => {
            const homeConfigDir = makeHomeConfig({
                credsStore: "desktop",
                credHelpers: {
                    "docker.io": "desktop",
                    "quay.io": "ecr-login",
                },
            });

            const withBase = new RegistryCredentialManager();
            await withBase.init(dataDir);

            await withBase.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            const config = readConfig();

            // With either of these left in place the docker CLI would ask a
            // helper binary that is not there instead of reading the login
            expect(config.credsStore).toBeUndefined();
            expect(config.credHelpers["docker.io"]).toBeUndefined();

            // Helpers for registries Dockge does not manage are none of its business
            expect(config.credHelpers["quay.io"]).toBe("ecr-login");

            fs.rmSync(homeConfigDir, {
                recursive: true,
                force: true,
            });
        });

        it("keeps the rest of the docker config directory reachable", async () => {
            const homeConfigDir = makeHomeConfig({});
            fs.mkdirSync(path.join(homeConfigDir, "cli-plugins"));
            fs.writeFileSync(path.join(homeConfigDir, "cli-plugins", "docker-compose"), "#!/bin/sh\n");

            const withBase = new RegistryCredentialManager();
            await withBase.init(dataDir);

            await withBase.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }]);

            // DOCKER_CONFIG moves the whole directory, so a compose plugin
            // installed next to the original config has to still be found
            expect(fs.existsSync(path.join(dataDir, "docker-config", "cli-plugins", "docker-compose"))).toBe(true);

            fs.rmSync(homeConfigDir, {
                recursive: true,
                force: true,
            });
        });

        it("leaves skopeo alone when the config could not be written", async () => {
            // A directory where the config.json should go makes the write fail
            fs.rmSync(configFile(), { force: true });
            fs.mkdirSync(configFile());

            await expect(manager.save([{
                registry: "docker.io",
                username: "user",
                password: "token",
            }])).rejects.toThrow();

            // Pointing skopeo at an authfile that is not there would fail every
            // update check instead of only the authenticated part
            expect(manager.skopeoAuthArgs()).toEqual([]);
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

        it("refuses to send the credentials to a token endpoint without TLS", async () => {
            const fetchMock = vi.fn(async () => new Response("", {
                status: 401,
                headers: {
                    "www-authenticate": "Bearer realm=\"http://registry.example.com/token\",service=\"registry.example.com\"",
                },
            }));
            vi.stubGlobal("fetch", fetchMock);

            const result = await manager.test("registry.example.com", "user", "token");

            expect(result.ok).toBe(false);
            expect(result.msg).toContain("unencrypted");

            // The point is that the credentials never went anywhere near it
            expect(fetchMock).toHaveBeenCalledTimes(1);
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
