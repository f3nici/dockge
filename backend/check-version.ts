import { log } from "./log";
import semver from "semver";
import packageJSON from "../package.json";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/f3nici/dockge/releases/latest";

class CheckVersion {
    hasUpdate = false;
    latestVersion?: string;
    interval? : NodeJS.Timeout;
    onUpdateFound?: () => void;

    async startInterval() {
        const check = async () => {
            log.debug("update-checker", "Checking GitHub for the latest release");

            try {
                await this.checkLatestRelease();
            } catch (_) {
                log.info("update-checker", "Failed to check GitHub for the latest release");
            }
        };

        await check();
        this.interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
    }

    async checkLatestRelease() {
        const res = await fetch(GITHUB_LATEST_RELEASE_API, {
            headers: {
                "Accept": "application/vnd.github+json",
            },
        });

        if (!res.ok) {
            log.debug("update-checker", `Could not fetch the latest release (HTTP ${res.status})`);
            return;
        }

        const data = await res.json();
        const tagName: string | undefined = data.tag_name;

        if (!tagName) {
            log.debug("update-checker", "No tag_name found in the latest release");
            return;
        }

        // Tags look like "V1.4"; coerce both the tag and our version to semver for comparison
        const latest = semver.coerce(tagName);
        const current = semver.coerce(packageJSON.version);

        if (!latest || !current) {
            log.debug("update-checker", `Could not parse versions (latest: ${tagName}, current: ${packageJSON.version})`);
            return;
        }

        const wasAlreadyKnown = this.hasUpdate;
        this.latestVersion = tagName;

        if (semver.gt(latest, current)) {
            this.hasUpdate = true;
            log.info("update-checker", `A new version is available: ${tagName} (current: ${packageJSON.version})`);

            // Notify connected clients about the newly discovered update
            if (!wasAlreadyKnown && this.onUpdateFound) {
                this.onUpdateFound();
            }
        } else {
            this.hasUpdate = false;
            log.debug("update-checker", "Running the latest version");
        }
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
