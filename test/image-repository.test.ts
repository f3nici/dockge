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

/**
 * A manifest as skopeo --raw writes it, and the digest the registry knows it
 * by, which is the sha256 of those exact bytes.
 * @param marker Anything that makes this manifest differ from the others
 */
function manifest(marker: string) {
    const raw = Buffer.from(JSON.stringify({
        schemaVersion: 2,
        marker,
    }));
    return {
        raw,
        digest: "sha256:" + createHash("sha256").update(raw).digest("hex"),
    };
}

const REMOTE = manifest("remote");

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

function mockSpawnOnce(stdout: string | Buffer) {
    spawnMock.mockResolvedValueOnce({ stdout } as never);
}

/** An error shaped like the one skopeo rejects with when a registry throttles us */
function rateLimitError() {
    return Object.assign(new Error("Error parsing image name: reading manifest"), {
        code: 1,
        stderr: "toomanyrequests: retry-after: 812.888\u00b5s, allowed: 44000/minute",
    });
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
        it("digests the raw manifest instead of making skopeo resolve the image", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            mockSpawnOnce(Buffer.from("{\"config\":{}}"));

            const info = await repo.update("stack", "caddy", "caddy");

            // "inspect --format {{ .Digest }}" reports the same digest, but makes
            // skopeo fetch the platform manifest and the config blob to get there
            expect(spawnMock).toHaveBeenNthCalledWith(
                2,
                "skopeo",
                [ "inspect", "--raw", "docker://caddy" ],
                expect.not.objectContaining({ encoding: expect.anything() }),
            );
            expect(info.remoteDigest).toBe(REMOTE.digest);
        });

        it("detects an available update when digests differ", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            // The remote config, which is a different image than the local one
            mockSpawnOnce(Buffer.from("{\"config\":{}}"));

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.remoteDigest).toBe(REMOTE.digest);
            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("reports no update when the local image is known by the remote digest under another repository", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(JSON.stringify([{
                Id: LOCAL_ID,
                RepoTags: [ "lscr.io/linuxserver/sonarr:latest" ],
                RepoDigests: [
                    "linuxserver/sonarr@" + LOCAL_DIGEST,
                    "lscr.io/linuxserver/sonarr@" + REMOTE.digest,
                ],
            }]));
            mockSpawnOnce(REMOTE.raw);

            const info = await repo.update("stack", "sonarr", "lscr.io/linuxserver/sonarr:latest");

            // The digest of the repository the stack references comes first
            expect(info.localDigest).toBe(REMOTE.digest);
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
                    "mirror.example.com/caddy@" + LOCAL_DIGEST,
                    "caddy@" + REMOTE.digest,
                ],
            }]));
            mockSpawnOnce(REMOTE.raw);

            const info = await repo.update("stack", "caddy", "docker.io/library/caddy:2");

            expect(info.localDigest).toBe(REMOTE.digest);
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
            mockSpawnOnce(REMOTE.raw);
            mockSpawnOnce(config);

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.remoteDigest).toBe(REMOTE.digest);
            expect(info.isImageUpdateAvailable()).toBe(false);
            // The config has to be read as raw bytes, not decoded text
            expect(spawnMock).toHaveBeenLastCalledWith(
                "skopeo",
                [ "inspect", "--config", "--raw", "docker://caddy" ],
                expect.not.objectContaining({ encoding: expect.anything() }),
            );
        });

        it("asks the registry once for an image several services share", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            mockSpawnOnce(Buffer.from("{\"config\":{}}"));
            // The second stack only inspects its local image
            mockSpawnOnce(imageInspectOutput);

            await repo.update("stack-a", "caddy", "caddy");
            const info = await repo.update("stack-b", "caddy", "caddy");

            expect(spawnMock).toHaveBeenCalledTimes(4);
            expect(info.remoteDigest).toBe(REMOTE.digest);
            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("reads the registry again once the remembered digests are dropped", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            mockSpawnOnce(Buffer.from("{\"config\":{}}"));
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);

            await repo.update("stack", "caddy", "caddy");
            // What the on-demand "check for updates" does before it starts
            repo.forgetRemoteDigests();
            repo.resetStack("stack");
            const info = await repo.update("stack", "caddy", "caddy");

            expect(spawnMock).toHaveBeenCalledTimes(5);
            expect(info.remoteDigest).toBe(REMOTE.digest);
        });

        it("reads the remote digest again once the cached one has aged out", async () => {
            vi.useFakeTimers();

            try {
                const repo = new ImageRepository();
                mockSpawnOnce(imageInspectOutput);
                mockSpawnOnce(REMOTE.raw);
                mockSpawnOnce(Buffer.from("{\"config\":{}}"));
                mockSpawnOnce(imageInspectOutput);
                mockSpawnOnce(REMOTE.raw);

                await repo.update("stack", "caddy", "caddy");
                vi.advanceTimersByTime(10 * 60 * 1000);
                repo.resetStack("stack");
                const info = await repo.update("stack", "caddy", "caddy");

                // Local inspect and remote digest, but not the config: that is
                // still the one already read for this remote digest
                expect(spawnMock).toHaveBeenCalledTimes(5);
                expect(info.isImageUpdateAvailable()).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it("reads the remote config again once the remote digest moves on", async () => {
            vi.useFakeTimers();

            try {
                const repo = new ImageRepository();
                const moved = manifest("moved-on");

                mockSpawnOnce(imageInspectOutput);
                mockSpawnOnce(REMOTE.raw);
                mockSpawnOnce(Buffer.from("{\"a\":1}"));
                mockSpawnOnce(imageInspectOutput);
                mockSpawnOnce(moved.raw);
                mockSpawnOnce(Buffer.from("{\"a\":2}"));

                await repo.update("stack", "caddy", "caddy");
                vi.advanceTimersByTime(10 * 60 * 1000);
                repo.resetStack("stack");
                await repo.update("stack", "caddy", "caddy");

                expect(spawnMock).toHaveBeenCalledTimes(6);
                expect(spawnMock).toHaveBeenLastCalledWith(
                    "skopeo",
                    [ "inspect", "--config", "--raw", "docker://caddy" ],
                    expect.anything(),
                );
            } finally {
                vi.useRealTimers();
            }
        });

        it("keeps reporting the update when the remote config cannot be read", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            spawnMock.mockRejectedValueOnce(new Error("manifest unknown"));

            const info = await repo.update("stack", "caddy", "caddy");

            expect(info.isImageUpdateAvailable()).toBe(true);
        });

        it("stops asking a registry that is rate limiting us", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(rateLimitError());
            mockSpawnOnce(imageInspectOutput);

            await repo.update("stack", "caddy", "caddy");
            const info = await repo.update("stack", "nginx", "nginx");

            // Two local inspects and the one skopeo run that was refused
            expect(spawnMock).toHaveBeenCalledTimes(3);
            expect(info.remoteDigest).toBe("");
            expect(info.isImageUpdateAvailable()).toBe(false);
            // Remote checks are still possible, this registry is just busy
            expect(repo.remoteChecksAvailable()).toBe(true);
        });

        it("only pauses the registry that refused, not the others", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(rateLimitError());
            mockSpawnOnce(imageInspectOutput);
            mockSpawnOnce(REMOTE.raw);
            mockSpawnOnce(Buffer.from("{\"config\":{}}"));

            await repo.update("stack", "caddy", "caddy");
            const info = await repo.update("stack", "app", "ghcr.io/owner/app:1");

            expect(info.remoteDigest).toBe(REMOTE.digest);
            expect(spawnMock).toHaveBeenLastCalledWith(
                "skopeo",
                [ "inspect", "--config", "--raw", "docker://ghcr.io/owner/app:1" ],
                expect.anything(),
            );
        });

        it("asks the registry again once the pause is over", async () => {
            vi.useFakeTimers();

            try {
                const repo = new ImageRepository();
                mockSpawnOnce(imageInspectOutput);
                spawnMock.mockRejectedValueOnce(rateLimitError());
                mockSpawnOnce(imageInspectOutput);
                mockSpawnOnce(REMOTE.raw);
                mockSpawnOnce(Buffer.from("{\"config\":{}}"));

                await repo.update("stack", "caddy", "caddy");
                vi.advanceTimersByTime(31 * 60 * 1000);
                const info = await repo.update("stack", "caddy", "caddy");

                expect(info.remoteDigest).toBe(REMOTE.digest);
            } finally {
                vi.useRealTimers();
            }
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
            expect(repo.remoteChecksAvailable()).toBe(false);
        });

        it("rethrows non-ENOENT skopeo errors", async () => {
            const repo = new ImageRepository();
            mockSpawnOnce(imageInspectOutput);
            spawnMock.mockRejectedValueOnce(Object.assign(new Error("exit code 1"), { code: 1 }));

            await expect(repo.update("stack", "caddy", "caddy")).rejects.toThrow("exit code 1");
        });
    });
});
