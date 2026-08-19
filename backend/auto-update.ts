import { Cron } from "croner";
import { DockgeServer } from "./dockge-server";
import { Settings } from "./settings";
import { Stack } from "./stack";
import { log } from "./log";
import { AgentManager } from "./agent-manager";
import { Agent } from "./models/agent";
import semver from "semver";
import { AUTO_UPDATE_DEFAULT, AUTO_UPDATE_DEFAULT_CRON, isDev, resolveAutoUpdate } from "../common/util-common";
import { AutoUpdateDefault, AutoUpdateRunOptions } from "../common/types";
import { LooseObject } from "../common/util-common";

export { AUTO_UPDATE_DEFAULT_CRON };

/**
 * How long to wait for an agent to report back before moving on without it.
 *
 * This only stops this instance from waiting: the agent carries on with its own
 * run, its stacks are simply not counted in the result. It is what keeps an
 * agent that never answers - unreachable, or too old to know the event - from
 * holding up the rest of the run.
 */
const AGENT_RUN_TIMEOUT = 60 * 60 * 1000;

/**
 * How long to wait for an agent connection to come up and log in.
 *
 * A scheduled run brings up its own connections and nobody is waiting on the
 * result, so it is worth giving a slow or briefly unreachable agent a bit of
 * time rather than skipping it for the whole run.
 */
const AGENT_CONNECT_TIMEOUT = 60 * 1000;

/**
 * The first Dockge version whose agents answer `runAutoUpdate`.
 *
 * An older agent silently ignores the event, so there is nothing to wait for:
 * it is skipped straight away with a log line saying why, instead of holding
 * the run open until it times out.
 */
const MIN_AGENT_VERSION = "1.8.1";

/**
 * Schedules and runs automatic stack updates.
 *
 * A single cron job is (re)created whenever the settings change. When it fires
 * (or when a user triggers "Update now"), every Dockge-managed, running stack
 * auto update applies to is checked, and pulled and recreated when it turns out
 * to be behind: `x-dockge.auto-update` in the stack's compose file decides
 * whether it takes part, falling back to the global default setting when the
 * stack does not set it.
 *
 * Stacks on agents are included: this instance runs its own stacks and then asks
 * every agent to do the same with the same settings, so the whole fleet follows
 * the schedule and default configured here.
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
     * The configured behaviour for stacks that do not set `x-dockge.auto-update`.
     */
    static async getDefaultBehaviour() : Promise<AutoUpdateDefault> {
        return (await Settings.get("autoUpdateDefault")) === "update" ? "update" : AUTO_UPDATE_DEFAULT;
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
     * Update every eligible stack right now, on this instance and on every agent.
     * @param options Settings to run with. Passed when an agent is running on
     * behalf of another instance, so that the whole fleet uses the same default;
     * omitted when this instance is the one starting the run, in which case the
     * settings are read here and then handed to the agents.
     * @returns The names of the stacks that were updated. Stacks on agents are
     * prefixed with their endpoint.
     */
    async runNow(options?: AutoUpdateRunOptions): Promise<string[]> {
        if (this.running) {
            throw new Error("An auto update is already running, please try again later.");
        }

        this.running = true;

        try {
            const runOptions : AutoUpdateRunOptions = options ?? {
                defaultBehaviour: await AutoUpdateManager.getDefaultBehaviour(),
                pruneAfterUpdate: !!(await Settings.get("autoUpdatePrune")),
            };

            log.info("auto-update", `Auto update started (default for stacks without a preference: ${runOptions.defaultBehaviour}, prune after update: ${runOptions.pruneAfterUpdate})`);

            const updated : string[] = [];
            let localError : unknown;

            try {
                updated.push(...await this.updateLocalStacks(runOptions));
            } catch (e) {
                // Reading this instance's stacks can fail as a whole, for
                // instance when docker is unreachable. The agents are separate
                // machines, so that must not stop them from running - the error
                // is raised once they have had their turn.
                log.error("auto-update", `Failed to update the local stacks: ${e}`);
                localError = e;
            }

            // A run an agent was asked to do covers that agent only: the instance
            // that started the run is the one that fans it out.
            if (!options) {
                updated.push(...await this.updateAgentStacks(runOptions));
            }

            // Whoever asked for the run has to hear about it: "Update now" reports
            // success purely on this not throwing
            if (localError) {
                throw localError;
            }

            log.info("auto-update", `Auto update finished. Updated ${updated.length} stack(s).`);
            return updated;
        } finally {
            this.running = false;
        }
    }

    /**
     * Update the eligible stacks of this instance.
     *
     * Eligible means managed by Dockge, running, opted in to auto update, and
     * actually behind: a stack whose images are already the ones the registry
     * has is left alone rather than pulled for nothing.
     * @param options Settings to run with
     * @returns The names of the stacks that were updated
     */
    protected async updateLocalStacks(options: AutoUpdateRunOptions): Promise<string[]> {
        const updated: string[] = [];
        const skipped: string[] = [];
        const failed: string[] = [];
        const stackList = await Stack.getStackList(this.server, true);

        for (const stack of stackList.values()) {
            if (!stack.isManagedByDockge) {
                continue;
            }

            // The stack's own x-dockge.auto-update wins; otherwise the global default
            if (!resolveAutoUpdate(stack.autoUpdate, options.defaultBehaviour)) {
                skipped.push(`${stack.name} (auto update not enabled)`);
                continue;
            }

            // Only touch stacks that are currently running
            if (!stack.isStarted) {
                skipped.push(`${stack.name} (not running)`);
                continue;
            }

            // Find out what the registries actually have before pulling anything.
            // "docker compose pull" fetches a manifest and an image config for
            // every service whether or not there is a new image, so pulling
            // every eligible stack is the bulk of the registry traffic a run
            // causes - and the reason a run can end up rate limited. A check
            // costs one manifest request per image and tells us which stacks
            // are worth the pull.
            await stack.refreshImageUpdateStatus();

            // Without skopeo nothing is ever flagged, so there is nothing to go
            // on and every eligible stack is pulled, as it was before.
            if (Stack.remoteImageChecksAvailable() && !stack.imageUpdatesAvailable && !stack.recreateNecessary) {
                skipped.push(`${stack.name} (no image updates available)`);
                continue;
            }

            try {
                log.info("auto-update", `Updating stack "${stack.name}"`);
                await stack.update(undefined, options.pruneAfterUpdate, false);
                updated.push(stack.name);
            } catch (e) {
                failed.push(stack.name);
                log.error("auto-update", `Failed to update stack "${stack.name}": ${e}`);
            }
        }

        // Logged in full: when a stack is not updated, the reason it was passed
        // over is the first thing anyone looking into it needs
        log.info("auto-update", `Updated ${updated.length} local stack(s)${updated.length ? ": " + updated.join(", ") : ""}`);
        if (failed.length > 0) {
            log.info("auto-update", `Failed to update ${failed.length} local stack(s): ${failed.join(", ")}`);
        }
        if (skipped.length > 0) {
            log.info("auto-update", `Skipped ${skipped.length} local stack(s): ${skipped.join(", ")}`);
        }

        this.server.sendStackList(false);
        return updated;
    }

    /**
     * Ask every agent to update its own eligible stacks with the given settings.
     *
     * An agent that is unreachable, still on an older version, or that fails
     * halfway is logged and skipped: one bad agent must not stop the others.
     * @param options Settings the agents should run with
     * @returns The names of the updated stacks, prefixed with their endpoint
     */
    protected async updateAgentStacks(options: AutoUpdateRunOptions): Promise<string[]> {
        let endpointList : string[];

        try {
            const agentList = await Agent.getAgentList();
            endpointList = Object.values(agentList)
                .map((agent) => agent.endpoint)
                .filter((endpoint) => !!endpoint);
        } catch (e) {
            log.error("auto-update", `Failed to read the agent list: ${e}`);
            return [];
        }

        if (endpointList.length === 0) {
            log.debug("auto-update", "No agents configured, nothing to fan out to");
            return [];
        }

        // Agent connections belong to a browser session, and a scheduled run
        // happens with nobody connected, so the run brings up its own.
        const agentManager = new AgentManager();
        await agentManager.connectAll();

        try {
            log.info("auto-update", `Running auto update on ${endpointList.length} agent(s)`);
            const results = await Promise.all(
                endpointList.map((endpoint) => this.updateOneAgent(agentManager, endpoint, options))
            );
            return results.flat();
        } finally {
            agentManager.disconnectAll();
        }
    }

    /**
     * Run an update on a single agent and wait for it to report back.
     * @param agentManager Manager holding the connection to the agent
     * @param endpoint The agent to update
     * @param options Settings the agent should run with
     * @returns The names of the updated stacks, prefixed with the endpoint
     */
    protected async updateOneAgent(agentManager: AgentManager, endpoint: string, options: AutoUpdateRunOptions): Promise<string[]> {
        // Give the connection time to come up first, so an agent that is simply
        // slow to answer is not mistaken for one that cannot be reached
        if (!await agentManager.waitUntilReady(endpoint, AGENT_CONNECT_TIMEOUT)) {
            log.error("auto-update", `Agent "${endpoint}" is not connected, skipping it. Check that the agent is running and that its credentials in Dockge are still valid.`);
            return [];
        }

        const version = agentManager.getAgentVersion(endpoint);

        if (version && !isDev && semver.satisfies(version, `< ${MIN_AGENT_VERSION}`)) {
            log.error("auto-update", `Agent "${endpoint}" runs Dockge ${version}, which does not take part in scheduled updates. Upgrade it to ${MIN_AGENT_VERSION} or newer, or give it its own auto update schedule.`);
            return [];
        }

        log.info("auto-update", `Running auto update on agent "${endpoint}"${version ? ` (Dockge ${version})` : ""}`);

        // A socket.io acknowledgement does not survive a reconnect: if the
        // connection drops, the reply to this run is lost even though the agent
        // carries on with it. Watching for that is what keeps a lost reply from
        // holding the run - and with it the next scheduled one - open for the
        // full timeout.
        const disconnectCount = agentManager.getDisconnectCount(endpoint);

        return new Promise((resolve) => {
            let done = false;
            let timeout : NodeJS.Timeout | undefined;
            let connectionWatch : NodeJS.Timeout | undefined;

            const finish = (updated : string[]) => {
                if (!done) {
                    done = true;
                    clearTimeout(timeout);
                    clearInterval(connectionWatch);
                    resolve(updated);
                }
            };

            connectionWatch = setInterval(() => {
                if (agentManager.getDisconnectCount(endpoint) !== disconnectCount) {
                    log.error("auto-update", `Lost the connection to agent "${endpoint}" while it was updating, so its reply can no longer arrive. It may well have finished the update; its stacks are simply not counted in this run.`);
                    finish([]);
                }
            }, 15 * 1000);

            timeout = setTimeout(() => {
                log.error("auto-update", `Agent "${endpoint}" did not report back within ${AGENT_RUN_TIMEOUT / 60000} minutes, continuing without it. It may still be updating, or be running a version of Dockge older than ${MIN_AGENT_VERSION}, which does not support scheduled updates.`);
                finish([]);
            }, AGENT_RUN_TIMEOUT);

            agentManager.emitToEndpoint(endpoint, "runAutoUpdate", options, (res : LooseObject) => {
                if (!res?.ok) {
                    log.error("auto-update", `Agent "${endpoint}" failed to auto update: ${res?.msg}`);
                    finish([]);
                    return;
                }

                const updated : string[] = Array.isArray(res.updated) ? res.updated : [];
                log.info("auto-update", `Agent "${endpoint}" updated ${updated.length} stack(s)${updated.length ? ": " + updated.join(", ") : ""}.`);
                finish(updated.map((name) => `${endpoint}/${name}`));
            }).catch((e) => {
                log.error("auto-update", `Could not reach agent "${endpoint}": ${e}`);
                finish([]);
            });
        });
    }
}
