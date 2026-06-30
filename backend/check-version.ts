import { log } from "./log";
import { Settings } from "./settings";
import childProcessAsync from "promisify-child-process";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const DOCKER_HUB_API = "https://hub.docker.com/v2/repositories/f3nici/dockge/tags";

class CheckVersion {
    hasLatestUpdate = false;
    hasTestingUpdate = false;
    interval? : NodeJS.Timeout;
    localDigests: Record<string, string> = {};
    onUpdateFound?: () => void;

    /**
     * Get the repo digest of a local Docker image.
     * Returns the digest portion (e.g. "sha256:abc...") or undefined if unavailable.
     */
    async getLocalImageDigest(image: string): Promise<string | undefined> {
        try {
            const res = await childProcessAsync.spawn(
                "docker", [ "inspect", "--format", "{{index .RepoDigests 0}}", image ],
                { encoding: "utf-8" }
            );
            const output = res.stdout?.toString().trim();
            if (output) {
                // Format is "repo@sha256:abc...", extract the digest part
                const atIndex = output.indexOf("@");
                return atIndex >= 0 ? output.substring(atIndex + 1) : output;
            }
        } catch (e) {
            log.debug("update-checker", `Could not get local digest for ${image}: ${e}`);
        }
        return undefined;
    }

    async startInterval() {
        const check = async () => {
            const checkLatest = await Settings.get("checkLatest");
            const checkTesting = await Settings.get("checkTesting");

            if (!checkLatest && !checkTesting) {
                return;
            }

            log.debug("update-checker", "Checking Docker Hub for image updates");

            try {
                if (checkLatest) {
                    await this.checkTag("latest");
                }
                if (checkTesting) {
                    await this.checkTag("testing");
                }
            } catch (_) {
                log.info("update-checker", "Failed to check Docker Hub for updates");
            }
        };

        await check();
        this.interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
    }

    async checkTag(tag: string) {
        try {
            // Get the local image digest if we haven't already
            if (!this.localDigests[tag]) {
                const localDigest = await this.getLocalImageDigest(`f3nici/dockge:${tag}`);
                if (localDigest) {
                    this.localDigests[tag] = localDigest;
                    log.debug("update-checker", `Local ${tag} digest: ${localDigest}`);
                } else {
                    log.debug("update-checker", `Could not determine local digest for ${tag}, skipping`);
                    return;
                }
            }

            const res = await fetch(`${DOCKER_HUB_API}/${tag}`);
            if (!res.ok) {
                log.debug("update-checker", `Tag ${tag} not found on Docker Hub`);
                return;
            }

            const data = await res.json();
            const remoteDigest = data.images?.[0]?.digest || data.digest;
            const lastUpdated = data.last_updated;

            if (!remoteDigest) {
                log.debug("update-checker", `No digest found for ${tag} on Docker Hub`);
                return;
            }

            // Compare the remote Docker Hub digest against our locally running image
            if (this.localDigests[tag] !== remoteDigest) {
                const wasAlreadyKnown = (tag === "latest" && this.hasLatestUpdate) ||
                    (tag === "testing" && this.hasTestingUpdate);

                if (tag === "latest") {
                    this.hasLatestUpdate = true;
                } else if (tag === "testing") {
                    this.hasTestingUpdate = true;
                }
                log.info("update-checker", `New ${tag} image available (updated: ${lastUpdated})`);

                // Notify connected clients about the newly discovered update
                if (!wasAlreadyKnown && this.onUpdateFound) {
                    this.onUpdateFound();
                }
            } else {
                log.debug("update-checker", `${tag} image is up to date`);
            }
        } catch (err) {
            log.debug("update-checker", `Failed to check ${tag} tag: ${err}`);
        }
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
