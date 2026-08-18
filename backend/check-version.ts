import { log } from "./log";
import semver from "semver";
import packageJSON from "../package.json";
import { ReleaseInfo } from "../common/types";
import { LooseObject } from "../common/util-common";

// How much time in ms to wait between update checks.
// A shorter interval means a freshly released version is noticed within hours
// rather than days.
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 6;
// If a check fails (e.g. transient network/GitHub error) retry sooner than the
// regular interval instead of waiting the full period.
const UPDATE_CHECKER_RETRY_MS = 1000 * 60 * 30;
// Give each GitHub request a hard timeout so a hung connection never leaves the
// checker stuck waiting forever.
const REQUEST_TIMEOUT_MS = 15 * 1000;

const GITHUB_API_BASE = "https://api.github.com/repos/f3nici/dockge";
const GITHUB_LATEST_RELEASE_API = `${GITHUB_API_BASE}/releases/latest`;
const GITHUB_RELEASES_API = `${GITHUB_API_BASE}/releases?per_page=10`;
const GITHUB_RELEASES_PAGE = "https://github.com/f3nici/dockge/releases";

// Release notes are pushed to every connected browser, so cap how much of a
// long changelog is carried over the socket. The dialog links to GitHub for
// the full text anyway.
const MAX_NOTES_LENGTH = 10000;

class CheckVersion {
    hasUpdate = false;
    latestVersion?: string;
    latestRelease?: ReleaseInfo;
    timer? : NodeJS.Timeout;
    onUpdateFound?: () => void;

    async startInterval() {
        const check = async () => {
            log.debug("update-checker", "Checking GitHub for the latest release");

            let ok = false;
            try {
                ok = await this.checkLatestRelease();
            } catch (e) {
                log.info("update-checker", "Failed to check GitHub for the latest release");
            }

            // Reschedule: retry sooner on failure, otherwise use the normal interval
            const nextDelay = ok ? UPDATE_CHECKER_INTERVAL_MS : UPDATE_CHECKER_RETRY_MS;
            this.timer = setTimeout(check, nextDelay);
        };

        await check();
    }

    /**
     * Fetch JSON from GitHub with a hard timeout.
     * @param url API url
     */
    private async fetchJSON(url : string) {
        return fetch(url, {
            headers: {
                "Accept": "application/vnd.github+json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    }

    /**
     * Turn a GitHub release API object into the shape the frontend consumes.
     * @param release Release object as returned by the GitHub API
     * @returns The release info, or undefined when it carries no usable tag
     */
    private toReleaseInfo(release : LooseObject) : ReleaseInfo | undefined {
        if (!release?.tag_name) {
            return undefined;
        }

        const notes = typeof release.body === "string" ? release.body.trim() : "";

        return {
            version: release.tag_name,
            // The release notes are optional: a release can be published with an
            // empty body, and the dialog copes with that.
            notes: notes.length > MAX_NOTES_LENGTH ? notes.slice(0, MAX_NOTES_LENGTH) : notes,
            notesTruncated: notes.length > MAX_NOTES_LENGTH,
            url: typeof release.html_url === "string" ? release.html_url : GITHUB_RELEASES_PAGE,
            publishedAt: typeof release.published_at === "string" ? release.published_at : undefined,
        };
    }

    /**
     * Resolve the latest release from GitHub.
     *
     * The `/releases/latest` endpoint only returns full releases (no drafts or
     * pre-releases). If that yields nothing (e.g. the newest release is flagged
     * as a pre-release), fall back to the releases list and pick the newest
     * non-draft entry so the checker keeps working.
     * @returns The latest release, or undefined when none could be resolved
     */
    private async resolveLatestRelease() : Promise<ReleaseInfo | undefined> {
        const latestRes = await this.fetchJSON(GITHUB_LATEST_RELEASE_API);

        if (latestRes.ok) {
            const release = this.toReleaseInfo(await latestRes.json());
            if (release) {
                return release;
            }
        } else if (latestRes.status !== 404) {
            log.debug("update-checker", `Could not fetch the latest release (HTTP ${latestRes.status})`);
            return undefined;
        }

        // Fallback: list releases and take the newest non-draft one
        const listRes = await this.fetchJSON(GITHUB_RELEASES_API);
        if (!listRes.ok) {
            log.debug("update-checker", `Could not fetch the releases list (HTTP ${listRes.status})`);
            return undefined;
        }

        const releases = await listRes.json();
        if (!Array.isArray(releases)) {
            return undefined;
        }

        // The API returns releases newest-first; skip drafts
        const newest = releases.find((r) => r && !r.draft && r.tag_name);
        return newest ? this.toReleaseInfo(newest) : undefined;
    }

    /**
     * Check GitHub for a newer release and update {@link hasUpdate}.
     * @returns true if the check completed (regardless of whether an update exists)
     */
    async checkLatestRelease() : Promise<boolean> {
        const release = await this.resolveLatestRelease();

        if (!release) {
            log.debug("update-checker", "No release tag found");
            return false;
        }

        const tagName = release.version;

        // Tags look like "V1.4"; coerce both the tag and our version to semver for comparison
        const latest = semver.coerce(tagName);
        const current = semver.coerce(packageJSON.version);

        if (!latest || !current) {
            log.debug("update-checker", `Could not parse versions (latest: ${tagName}, current: ${packageJSON.version})`);
            return false;
        }

        // A previously announced update stays "already known" only while it is
        // still the same release: a newer one published in the meantime should
        // pop the dialog again.
        const wasAlreadyKnown = this.hasUpdate && this.latestVersion === tagName;
        this.latestVersion = tagName;
        this.latestRelease = release;

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

        return true;
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
