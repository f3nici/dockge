import { log } from "./log";
import { Settings } from "./settings";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const DOCKER_HUB_API = "https://hub.docker.com/v2/repositories/f3nici/dockge/tags";

interface DockerTagInfo {
    digest: string;
    lastUpdated: string;
}

class CheckVersion {
    latestTagInfo?: DockerTagInfo;
    testingTagInfo?: DockerTagInfo;
    currentLatestDigest?: string;
    currentTestingDigest?: string;
    hasLatestUpdate = false;
    hasTestingUpdate = false;
    interval? : NodeJS.Timeout;

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
            const res = await fetch(`${DOCKER_HUB_API}/${tag}`);
            if (!res.ok) {
                log.debug("update-checker", `Tag ${tag} not found on Docker Hub`);
                return;
            }

            const data = await res.json();
            const digest = data.images?.[0]?.digest || data.digest;
            const lastUpdated = data.last_updated;

            if (tag === "latest") {
                if (this.currentLatestDigest && this.currentLatestDigest !== digest) {
                    this.hasLatestUpdate = true;
                    log.info("update-checker", `New latest image available (updated: ${lastUpdated})`);
                }
                this.latestTagInfo = { digest, lastUpdated };
                if (!this.currentLatestDigest) {
                    this.currentLatestDigest = digest;
                }
            } else if (tag === "testing") {
                if (this.currentTestingDigest && this.currentTestingDigest !== digest) {
                    this.hasTestingUpdate = true;
                    log.info("update-checker", `New testing image available (updated: ${lastUpdated})`);
                }
                this.testingTagInfo = { digest, lastUpdated };
                if (!this.currentTestingDigest) {
                    this.currentTestingDigest = digest;
                }
            }
        } catch (err) {
            log.debug("update-checker", `Failed to check ${tag} tag: ${err}`);
        }
    }

    /**
     * Initialize current digests from the running container
     */
    setCurrentDigests(latestDigest?: string, testingDigest?: string) {
        if (latestDigest) {
            this.currentLatestDigest = latestDigest;
        }
        if (testingDigest) {
            this.currentTestingDigest = testingDigest;
        }
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
