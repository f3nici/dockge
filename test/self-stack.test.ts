import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEnvFile, buildHandOffScript, containerIdFromMountInfo, SelfStack, shellQuote } from "../backend/self-stack";

const ID = "4b9c1f0e2d3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";

afterEach(() => {
    vi.restoreAllMocks();
    SelfStack.reset();
});

describe("containerIdFromMountInfo", () => {
    it("finds the ID in the mounts docker makes for /etc/hostname and friends", () => {
        const mountInfo = [
            "612 590 0:52 / / rw,relatime master:304 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/X",
            `634 612 254:1 /var/lib/docker/containers/${ID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw`,
            `635 612 254:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw`,
        ].join("\n");

        expect(containerIdFromMountInfo(mountInfo)).toBe(ID);
    });

    it("finds it under a docker data root that is not the default one", () => {
        const mountInfo = `634 612 254:1 /srv/docker-data/containers/${ID}/hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw`;

        expect(containerIdFromMountInfo(mountInfo)).toBe(ID);
    });

    it("finds nothing outside a container", () => {
        const mountInfo = "22 1 254:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw";

        expect(containerIdFromMountInfo(mountInfo)).toBeUndefined();
    });
});

describe("shellQuote", () => {
    it("quotes a value so a shell reads it back unchanged", () => {
        for (const value of [ "/opt/stacks/dockge", "a path with spaces", "it's", "$HOME `id` \"x\"" ]) {
            const echoed = execFileSync("sh", [ "-c", `printf %s ${shellQuote(value)}` ]).toString();
            expect(echoed).toBe(value);
        }
    });
});

describe("buildHandOffScript", () => {
    it("waits, runs the command in the stack folder, and leaves the exit code in the log", () => {
        const script = buildHandOffScript({
            stackPath: "/opt/stacks/dockge",
            args: [ "compose", "up", "-d", "--remove-orphans" ],
        }, "/app/data/self-update.log");

        expect(script).toMatch(/^sleep \d+\n/);
        expect(script).toContain("cd '/opt/stacks/dockge' || exit 1");
        expect(script).toContain("docker 'compose' 'up' '-d' '--remove-orphans' > '/app/data/self-update.log' 2>&1");
        expect(script).toContain("echo \"exit:$code\" >> '/app/data/self-update.log'");
        expect(script).not.toContain("prune");
    });

    it("prunes afterwards when asked to", () => {
        const dangling = buildHandOffScript({
            stackPath: "/s",
            args: [ "compose", "up", "-d" ],
            prune: true,
        }, "/log");
        const all = buildHandOffScript({
            stackPath: "/s",
            args: [ "compose", "up", "-d" ],
            prune: true,
            pruneAll: true,
        }, "/log");

        expect(dangling).toContain("docker image prune -f >> '/log' 2>&1");
        expect(all).toContain("docker image prune -f -a >> '/log' 2>&1");
    });

    it("is a script sh accepts", () => {
        const script = buildHandOffScript({
            stackPath: "/opt/stacks/my stack",
            args: [ "compose", "restart", "web" ],
            prune: true,
        }, "/tmp/it's a log");

        expect(() => execFileSync("sh", [ "-n", "-c", script ])).not.toThrow();
    });
});

describe("buildEnvFile", () => {
    it("passes Dockge's environment on, except what is the container's own", () => {
        const file = buildEnvFile({
            TZ: "Australia/Perth",
            DOCKGE_STACKS_DIR: "/opt/stacks",
            HOSTNAME: "4b9c1f0e2d3a",
            MULTILINE: "a\nb",
            "NOT-A-NAME": "x",
            UNSET: undefined,
        });

        expect(file).toBe("TZ=Australia/Perth\nDOCKGE_STACKS_DIR=/opt/stacks\n");
    });
});

describe("SelfStack.isSelfStack", () => {
    it("matches the compose project Dockge's container belongs to", async () => {
        vi.spyOn(SelfStack, "getSelfContainer").mockResolvedValue({
            id: ID,
            image: "sha256:abc",
            imageRef: "louislam/dockge:1",
            project: "dockge",
            service: "dockge",
            networks: [ "dockge_default" ],
        });

        expect(await SelfStack.isSelfStack("dockge")).toBe(true);
        expect(await SelfStack.isSelfStack("nginx")).toBe(false);
        expect(await SelfStack.isSelfService("dockge", "dockge")).toBe(true);
        expect(await SelfStack.isSelfService("dockge", "sidecar")).toBe(false);
    });

    it("matches nothing when Dockge is not in a compose stack", async () => {
        vi.spyOn(SelfStack, "getSelfContainer").mockResolvedValue(null);

        expect(await SelfStack.isSelfStack("dockge")).toBe(false);
        expect(await SelfStack.isSelfService("dockge", "dockge")).toBe(false);
    });
});

describe("SelfStack.finishPendingHandOff", () => {
    it("waits for a helper that is still at work when Dockge is back", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "dockge-self-update-"));

        try {
            writeFileSync(path.join(dir, "self-update.json"), JSON.stringify({
                helper: "dockge-self-update-1",
                args: [ "compose", "up", "-d", "--remove-orphans" ],
                startedAt: "2026-10-21T00:00:00.000Z",
                historyId: 7,
            }));

            // Compose has started Dockge's new container, but the prune that
            // comes after it has not finished yet
            writeFileSync(path.join(dir, "self-update.log"), "Container dockge-dockge-1  Started\n");

            const complete = vi.fn(async () => {});
            const helperRunning = vi.fn(async () => {
                // ...and then it does, and the helper is gone
                appendFileSync(path.join(dir, "self-update.log"), "Total reclaimed space: 0B\nexit:0\n");
                return false;
            });

            await SelfStack.finishPendingHandOff(dir, complete, helperRunning);

            expect(helperRunning).toHaveBeenCalledWith("dockge-self-update-1");
            expect(complete).toHaveBeenCalledWith(7, true, "Container dockge-dockge-1  Started\nTotal reclaimed space: 0B", expect.any(String));
            expect(existsSync(path.join(dir, "self-update.json"))).toBe(false);
            expect(existsSync(path.join(dir, "self-update.log"))).toBe(false);
        } finally {
            rmSync(dir, {
                recursive: true,
                force: true,
            });
        }
    });

    it("records a failure when the helper left no result behind", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "dockge-self-update-"));

        try {
            writeFileSync(path.join(dir, "self-update.json"), JSON.stringify({
                helper: "dockge-self-update-2",
                args: [ "compose", "up", "-d" ],
                startedAt: "2026-10-21T00:00:00.000Z",
                historyId: 8,
            }));

            const complete = vi.fn(async () => {});
            await SelfStack.finishPendingHandOff(dir, complete, async () => false);

            expect(complete).toHaveBeenCalledWith(8, false, "", expect.any(String));
        } finally {
            rmSync(dir, {
                recursive: true,
                force: true,
            });
        }
    });
});
