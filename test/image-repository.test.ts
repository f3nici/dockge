import { describe, it, expect, vi, beforeEach } from "vitest";

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

const imageInspectOutput = JSON.stringify([{
    Id: "sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9",
    RepoTags: [ "caddy:latest" ],
    RepoDigests: [ "caddy@sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9" ],
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
            mockSpawnOnce("sha256:0000000000000000000000000000000000000000000000000000000000000000\n");

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.remoteDigest).toBe("sha256:0000000000000000000000000000000000000000000000000000000000000000");
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
