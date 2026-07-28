import { Cron } from "croner";
import { DockgeServer } from "./dockge-server";
import { Settings } from "./settings";
import { Stack } from "./stack";
import { log } from "./log";

// Weekly, every Sunday at 04:00. Matches the "once a week" default requested in the issue.
export const AUTO_UPDATE_DEFAULT_CRON = "0 4 * * 0";

/**
 * Schedules and runs automatic stack updates.
 *
 * A single cron job is (re)created whenever the settings change. When it fires
 * (or when a user triggers "Update now"), every Dockge-managed, running stack is
 * pulled and recreated, unless it opts out via `x-dockge.skip-auto-update: true`.
 */
export class AutoUpdateManager {
    protected server: DockgeServer;
    protected job?: Cron;
    protected running = false;

    constructor(server: DockgeServer) {
        this.server = server;
    }

    /**
     * Validate a cron expression, throwing if it is not parseable by croner.
     * @param pattern Cron expression to validate
     */
    static validateCron(pattern: string) {
        // Constructing a paused job validates the pattern without scheduling anything.
        const job = new Cron(pattern, { paused: true });
        job.stop();
    }

    /**
     * (Re)create the cron job from the current settings. Safe to call repeatedly;
     * any previously scheduled job is stopped first.
     */
    async schedule() {
        this.stop();

        const enabled = await Settings.get("autoUpdateEnabled");
        if (!enabled) {
            log.info("auto-update", "Auto update is disabled");
            return;
        }

        const cronPattern = (await Settings.get("autoUpdateCron")) || AUTO_UPDATE_DEFAULT_CRON;

        try {
            this.job = new Cron(cronPattern, {
                protect: true, // Skip a run if the previous one is still going
            }, () => {
                this.runNow().catch((e) => log.error("auto-update", e));
            });
            log.info("auto-update", `Auto update scheduled ("${cronPattern}"), next run: ${this.job.nextRun()}`);
        } catch (e) {
            log.error("auto-update", `Invalid cron expression "${cronPattern}": ${e}`);
        }
    }

    /**
     * Stop the currently scheduled job, if any.
     */
    stop() {
        if (this.job) {
            this.job.stop();
            this.job = undefined;
        }
    }

    /**
     * The timestamp of the next scheduled run, or null when disabled.
     */
    nextRun(): Date | null {
        return this.job ? this.job.nextRun() : null;
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Update every eligible stack right now.
     * @returns The names of the stacks that were updated.
     */
    async runNow(): Promise<string[]> {
        if (this.running) {
            throw new Error("An auto update is already running, please try again later.");
        }

        this.running = true;
        const updated: string[] = [];

        try {
            const pruneAfterUpdate = !!(await Settings.get("autoUpdatePrune"));
            const stackList = await Stack.getStackList(this.server, true);

            for (const stack of stackList.values()) {
                if (!stack.isManagedByDockge) {
                    continue;
                }

                if (stack.skipAutoUpdate) {
                    log.info("auto-update", `Skipping stack "${stack.name}" (skip-auto-update)`);
                    continue;
                }

                // Only touch stacks that are currently running
                if (!stack.isStarted) {
                    log.debug("auto-update", `Skipping stack "${stack.name}" (not running)`);
                    continue;
                }

                try {
                    log.info("auto-update", `Updating stack "${stack.name}"`);
                    await stack.update(undefined, pruneAfterUpdate, false);
                    updated.push(stack.name);
                } catch (e) {
                    log.error("auto-update", `Failed to update stack "${stack.name}": ${e}`);
                }
            }

            this.server.sendStackList(false);
            log.info("auto-update", `Auto update finished. Updated ${updated.length} stack(s).`);
        } finally {
            this.running = false;
        }

        return updated;
    }
}
