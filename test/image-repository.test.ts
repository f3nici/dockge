import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

vi.mock("promisify-child-process", () => ({
    default: {
        spawn: vi.fn(),
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

import childProcessAsync from "promisify-child-process";
import { log } from "../backend/log";
import { ImageRepository } from "../backend/image-repository";

const spawnMock = vi.mocked(childProcessAsync.spawn);
const warnMock = vi.mocked(log.warn);

const LOCAL_ID = "sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9";
const LOCAL_DIGEST = "sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9";
const OTHER_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const imageInspectOutput = JSON.stringify([{
    Id: LOCAL_ID,
    RepoTags: [ "caddy:latest" ],
    RepoDigests: [ "caddy@" + LOCAL_DIGEST ],
}]);

const emptyInspectOutput = JSON.stringify([{
    Id: "sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9",
    RepoTags: null,
    RepoDigests: null,
}]);

function mockSpawnOnce(stdout: string) {
    spawnMock.mockResolvedValueOnce({ stdout } as never);
}

describe("ImageRepository", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("updateLocal", () => {
        it("uses 'docker image inspect' so container names cannot shadow images", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);

            await repo.updateLocal("stack", "caddy", "caddy");

            expect(spawnMock).toHaveBeenCalledWith(
                "docker",
                [ "image", "inspect", "--format", "json", "caddy" ],
                expect.anything(),
            );
        });

        it("extracts the digest after the @ separator", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);

            const info = await repo.updateLocal("stack", "caddy", "caddy");

            expect(info.localDigest).toBe("sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9");
            expect(info.localId).toBe("sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9");
        });

        it("warns only once per image when digest info is missing", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(emptyInspectOutput);
            mockSpawnOnce(emptyInspectOutput);

            await repo.updateLocal("stack", "caddy", "caddy");
            await repo.updateLocal("stack", "caddy", "caddy");

            expect(warnMock).toHaveBeenCalledTimes(1);
        });

        it("warns again if the image breaks after a successful inspect", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(emptyInspectOutput);
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(emptyInspectOutput);

            await repo.updateLocal("stack", "caddy", "caddy");
            await repo.updateLocal("stack", "caddy", "caddy");
            await repo.updateLocal("stack", "caddy", "caddy");

            expect(warnMock).toHaveBeenCalledTimes(2);
        });
    });

    describe("update", () => {
        it("detects an available update when digests differ", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(OTHER_DIGEST + "\n");
            // The remote config, which is a different image than the local one
            mockSpawnOnce("{\"config\":{}}");

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.remoteDigest).toBe(OTHER_DIGEST);
            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("reports no update when the local image is known by the remote digest under another repository", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(JSON.stringify([{
                Id: LOCAL_ID,
                RepoTags: [ "lscr.io/linuxserver/sonarr:latest" ],
                RepoDigests: [
                    "linuxserver/sonarr@" + OTHER_DIGEST,
                    "lscr.io/linuxserver/sonarr@" + LOCAL_DIGEST,
                ],
            }]));
            mockSpawnOnce(LOCAL_DIGEST + "\n");

            const info = await repo.update("stack", "sonarr", "lscr.io/linuxserver/sonarr:latest");

            // The digest of the repository the stack references comes first
            expect(info.localDigest).toBe(LOCAL_DIGEST);
            expect(info.isImageUpdateAvailable()).toBe(false);
            // No config check needed: the manifest digests already match
            expect(spawnMock).toHaveBeenCalledTimes(2);
        });

        it("matches the repository of the image reference regardless of how it is written", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(JSON.stringify([{
                Id: LOCAL_ID,
                RepoTags: [ "caddy:2" ],
                RepoDigests: [
                    "mirror.example.com/caddy@" + OTHER_DIGEST,
                    "caddy@" + LOCAL_DIGEST,
                ],
            }]));
            mockSpawnOnce(LOCAL_DIGEST + "\n");

            const info = await repo.update("stack", "caddy", "docker.io/library/caddy:2");

            expect(info.localDigest).toBe(LOCAL_DIGEST);
            expect(info.isImageUpdateAvailable()).toBe(false);
        });

        it("reports no update when only the manifest digest differs but the image config is the same", async () => {
            const repo = new ImageRepository();
            // skopeo writes the config blob out verbatim, and its digest is what
            // Docker reports as the local image id
            const config = Buffer.from("{\"architecture\":\"amd64\"}");
            const configDigest = "sha256:" + createHash("sha256").update(config).digest("hex");

            mockSpawnOnce(JSON.stringify([{
                Id: configDigest,
                RepoTags: [ "caddy:latest" ],
                RepoDigests: [ "caddy@" + LOCAL_DIGEST ],
            }]));
            mockSpawnOnce(OTHER_DIGEST + "\n");
            spawnMock.mockResolvedValueOnce({ stdout: config } as never);

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.remoteDigest).toBe(OTHER_DIGEST);
            expect(info.isImageUpdateAvailable()).toBe(false);
            // The config has to be read as raw bytes, not decoded text
            expect(spawnMock).toHaveBeenLastCalledWith(
                "skopeo",
                [ "inspect", "--config", "--raw", "docker://caddy" ],
                expect.not.objectContaining({ encoding: expect.anything() }),
            );
        });

        it("reads the remote config once per remote digest, not once per check", async () => {
            const repo = new ImageRepository();
            const config = Buffer.from("{\"architecture\":\"amd64\"}");

            // First check: local inspect, remote digest, remote config
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(OTHER_DIGEST + "\n");
            spawnMock.mockResolvedValueOnce({ stdout: config } as never);
            // Second check, same remote digest: local inspect and remote digest only
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(OTHER_DIGEST + "\n");

            await repo.update("stack", "caddy", "caddy");
            // Every check starts by dropping what is known about the stack
            repo.resetStack("stack");
            const info = await repo.update("stack", "caddy", "caddy");

            expect(spawnMock).toHaveBeenCalledTimes(5);
            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("reads the remote config again once the remote digest moves on", async () => {
            const repo = new ImageRepository();
            const thirdDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(OTHER_DIGEST + "\n");
            spawnMock.mockResolvedValueOnce({ stdout: Buffer.from("{\"a\":1}") } as never);
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(thirdDigest + "\n");
            spawnMock.mockResolvedValueOnce({ stdout: Buffer.from("{\"a\":2}") } as never);

            await repo.update("stack", "caddy", "caddy");
            repo.resetStack("stack");
            await repo.update("stack", "caddy", "caddy");

            expect(spawnMock).toHaveBeenCalledTimes(6);
            expect(spawnMock).toHaveBeenLastCalledWith(
                "skopeo",
                [ "inspect", "--config", "--raw", "docker://caddy" ],
                expect.anything(),
            );
        });

        it("keeps reporting the update when the remote config cannot be read", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(OTHER_DIGEST + "\n");
            spawnMock.mockRejectedValueOnce(new Error("manifest unknown"));

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("skips the remote check for digest-pinned images", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);

            await repo.update("stack", "caddy", "caddy@sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9");

            // only the local inspect, no skopeo call
            expect(spawnMock).toHaveBeenCalledTimes(1);
        });

        it("handles a missing skopeo binary gracefully and warns once", async () => {
            const repo = new ImageRepository();
            const enoent = Object.assign(new Error("spawn skopeo ENOENT"), { code: "ENOENT" });

            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(enoent);
            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(enoent);

            const info = await repo.update("stack", "caddy", "caddy");
            await repo.update("stack", "caddy", "caddy");

            expect(info.localDigest).toBe("sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9");
            expect(info.remoteDigest).toBe("");
            expect(warnMock).toHaveBeenCalledTimes(1);
        });

        it("rethrows non-ENOENT skopeo errors", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(Object.assign(new Error("exit code 1"), { code: 1 }));

            await expect(repo.update("stack", "caddy", "caddy")).rejects.toThrow("exit code 1");
        });
    });
});
