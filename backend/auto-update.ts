import { Cron } from "croner";
import { DockgeServer } from "./dockge-server";
import { Settings } from "./settings";
import { Stack } from "./stack";
import { log } from "./log";
import { AgentManager } from "./agent-manager";
import { Agent } from "./models/agent";
import { AUTO_UPDATE_DEFAULT, AUTO_UPDATE_DEFAULT_CRON, resolveAutoUpdate } from "../common/util-common";
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
const AGENT_RUN_TIMEOUT = 10 * 60 * 1000;

/**
 * Schedules and runs automatic stack updates.
 *
 * A single cron job is (re)created whenever the settings change. When it fires
 * (or when a user triggers "Update now"), every Dockge-managed, running stack is
 * pulled and recreated if auto update applies to it: `x-dockge.auto-update` in
 * the stack's compose file decides, falling back to the global default setting
 * when the stack does not set it.
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

            const updated = await this.updateLocalStacks(runOptions);

            // A run an agent was asked to do covers that agent only: the instance
            // that started the run is the one that fans it out.
            if (!options) {
                updated.push(...await this.updateAgentStacks(runOptions));
            }

            log.info("auto-update", `Auto update finished. Updated ${updated.length} stack(s).`);
            return updated;
        } finally {
            this.running = false;
        }
    }

    /**
     * Update the eligible stacks of this instance.
     * @param options Settings to run with
     * @returns The names of the stacks that were updated
     */
    protected async updateLocalStacks(options: AutoUpdateRunOptions): Promise<string[]> {
        const updated: string[] = [];
        const stackList = await Stack.getStackList(this.server, true);

        for (const stack of stackList.values()) {
            if (!stack.isManagedByDockge) {
                continue;
            }

            // The stack's own x-dockge.auto-update wins; otherwise the global default
            if (!resolveAutoUpdate(stack.autoUpdate, options.defaultBehaviour)) {
                log.debug("auto-update", `Skipping stack "${stack.name}" (auto update not enabled)`);
                continue;
            }

            // Only touch stacks that are currently running
            if (!stack.isStarted) {
                log.debug("auto-update", `Skipping stack "${stack.name}" (not running)`);
                continue;
            }

            try {
                log.info("auto-update", `Updating stack "${stack.name}"`);
                await stack.update(undefined, options.pruneAfterUpdate, false);
                updated.push(stack.name);
            } catch (e) {
                log.error("auto-update", `Failed to update stack "${stack.name}": ${e}`);
            }
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
    protected updateOneAgent(agentManager: AgentManager, endpoint: string, options: AutoUpdateRunOptions): Promise<string[]> {
        return new Promise((resolve) => {
            let done = false;

            const finish = (updated : string[]) => {
                if (!done) {
                    done = true;
                    resolve(updated);
                }
            };

            const timeout = setTimeout(() => {
                log.error("auto-update", `Agent "${endpoint}" did not report back in time, continuing without it. It may still be updating, or be running an older version of Dockge.`);
                finish([]);
            }, AGENT_RUN_TIMEOUT);

            agentManager.emitToEndpoint(endpoint, "runAutoUpdate", options, (res : LooseObject) => {
                clearTimeout(timeout);

                if (!res?.ok) {
                    log.error("auto-update", `Agent "${endpoint}" failed to auto update: ${res?.msg}`);
                    finish([]);
                    return;
                }

                const updated : string[] = Array.isArray(res.updated) ? res.updated : [];
                log.info("auto-update", `Agent "${endpoint}" updated ${updated.length} stack(s).`);
                finish(updated.map((name) => `${endpoint}/${name}`));
            }).catch((e) => {
                clearTimeout(timeout);
                log.error("auto-update", `Could not reach agent "${endpoint}": ${e}`);
                finish([]);
            });
        });
    }
}
