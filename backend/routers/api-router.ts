import express, { Express, NextFunction, Request, Response, Router as ExpressRouter } from "express";
import childProcessAsync from "promisify-child-process";
import semver from "semver";
import { DockgeServer } from "../dockge-server";
import { Router } from "../router";
import { log } from "../log";
import { Stack } from "../stack";
import { Agent } from "../models/agent";
import { Settings } from "../settings";
import { ApiCaller, ApiKeys } from "../api-keys";
import { AutoUpdateManager } from "../auto-update";
import { AgentManager } from "../agent-manager";
import { KumaRateLimiter } from "../rate-limiter";
import { clientIPFrom } from "../util-server";
import { collectHistory, historySources, UpdateHistory } from "../update-history";
import { ApiError, ApiStack, errorStatus, parsePolicy, policyName, resolveEndpoint, stackView } from "../api-views";
import { ALL_ENDPOINTS, AUTO_UPDATE_DEFAULT_CRON, isDev, LooseObject, resolveAutoUpdate } from "../../common/util-common";
import { AutoUpdateDefault, AutoUpdateRunOptions, ServiceData, SimpleStackData, UpdateHistoryFilter } from "../../common/types";

/**
 * The first Dockge version an agent has to run for the REST API to act on it:
 * the one that answers getStackList, and that keeps an API connection out of
 * the stack logs it would otherwise stream to it for good.
 */
const MIN_AGENT_VERSION_API = "2.3.0";

/** How long the API waits for an agent to come online */
const AGENT_READY_TIMEOUT = 10 * 1000;

/**
 * How long listing the agents waits for their connections to come up. Short:
 * Home Assistant gives GET /api/agents 10 seconds in all, and an agent that is
 * offline never comes up.
 */
const AGENT_LIST_WAIT = 3 * 1000;

/** How long an agent gets to answer a question */
const AGENT_QUERY_TIMEOUT = 20 * 1000;

/** How long an agent gets to start, stop or restart a stack */
const AGENT_ACTION_TIMEOUT = 10 * 60 * 1000;

/** How long an agent gets to update a stack: pulls can be slow */
const AGENT_UPDATE_TIMEOUT = 30 * 60 * 1000;

/** How long an agent gets for an "Update all" of its own */
const AGENT_UPDATE_ALL_TIMEOUT = 60 * 60 * 1000;

/** How often the image update check runs, see DockgeServer.serve() */
const IMAGE_CHECK_INTERVAL_HOURS = 3;

/**
 * Requests with a wrong key, budgeted per client address. A key has 256
 * random bits, so this is not what keeps one from being guessed; it keeps a
 * misconfigured client from filling the log.
 */
const authFailureLimiter = new KumaRateLimiter({
    tokensPerInterval: 30,
    interval: "minute",
    fireImmediately: true,
    globalTokensPerInterval: 300,
    errorMessage: "Too many requests with a wrong API key, try again later.",
});

type ApiRequest = Request & { apiCaller? : ApiCaller };

/**
 * The REST API, for Home Assistant and other automation.
 *
 * Off until a key exists: one created under Settings → API, or one set in the
 * DOCKGE_API_KEY environment variable. Requests send it in an X-API-Key
 * header, or as "Authorization: Bearer <key>". A read-only key may only make
 * GET requests.
 *
 * The endpoints and what they send follow the REST API of finder39/dockge, so
 * its Home Assistant integration works against this one too. Every endpoint
 * that is about one instance takes ?endpoint=, which is an agent's endpoint or
 * its name; without it, it is about this instance, or about all of them for
 * lists.
 */
export class ApiRouter extends Router {
    create(app : Express, server : DockgeServer) : ExpressRouter {
        const router = express.Router();

        router.use("/api", express.json({
            limit: "100kb",
        }));

        // Public: says the API is there, and nothing about what is behind it
        router.get("/api/health", (_req, res) => {
            res.json({
                ok: true,
                status: "ok",
                version: server.packageJSON.version,
            });
        });

        router.use("/api", (req, res, next) => {
            authenticate(req as ApiRequest, res, next).catch(next);
        });

        // Agents

        router.get("/api/agents", handle(async () => {
            return {
                agents: await listAgents(server, false),
            };
        }));

        router.get("/api/agents/status", handle(async () => {
            return {
                agents: await listAgents(server, true),
            };
        }));

        // Stacks

        router.get("/api/stacks", handle(async (req) => {
            const endpoint = await requestedEndpoint(req);
            const defaultBehaviour = await AutoUpdateManager.getDefaultBehaviour();
            const endpoints = endpoint === undefined ? await allEndpoints() : [ endpoint ];

            const stacks : ApiStack[] = [];
            const unreachable : string[] = [];

            await Promise.all(endpoints.map(async (ep) => {
                try {
                    stacks.push(...await stacksOf(server, ep, defaultBehaviour));
                } catch (e) {
                    log.warn("api", `Could not list the stacks of ${ep || "this instance"}: ${e instanceof Error ? e.message : e}`);
                    unreachable.push(ep);
                }
            }));

            stacks.sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.name.localeCompare(b.name));

            return {
                stacks,
                unreachable,
            };
        }));

        router.get("/api/stacks/:name/status", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const defaultBehaviour = await AutoUpdateManager.getDefaultBehaviour();

            let data : SimpleStackData & { services? : Record<string, ServiceData> };

            if (endpoint === "") {
                const stack = await Stack.getStack(server, req.params.name);
                await stack.updateData();
                data = await stack.getData("");
            } else {
                data = (await askAgent(server, endpoint, "updateStackData", AGENT_QUERY_TIMEOUT, req.params.name)).stack;
            }

            return {
                stack: stackView(data, data.services, endpoint, defaultBehaviour),
            };
        }));

        router.post("/api/stacks/:name/update", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const { prune, pruneAll } = pruneOptions(req.body);

            if (endpoint === "") {
                const stack = await managedStack(server, req.params.name);
                const self = await stack.isSelfStack();
                await stack.update(undefined, prune, pruneAll, "api");
                server.sendStackList(true);
                return {
                    message: self ? `Stack '${stack.name}' pulled; Dockge restarts in a few seconds to finish the update` : `Stack '${stack.name}' updated`,
                    endpoint,
                };
            }

            await askAgent(server, endpoint, "updateStack", AGENT_UPDATE_TIMEOUT, req.params.name, prune, pruneAll);
            return {
                message: `Stack '${req.params.name}' updated on ${endpoint}`,
                endpoint,
            };
        }));

        for (const action of [ "start", "stop", "restart" ] as const) {
            router.post(`/api/stacks/:name/${action}`, handle(async (req) => {
                const endpoint = await requestedEndpoint(req) ?? "";

                if (endpoint === "") {
                    const stack = await managedStack(server, req.params.name);
                    await stack[action](undefined);
                    server.sendStackList(true);
                } else {
                    await askAgent(server, endpoint, `${action}Stack`, AGENT_ACTION_TIMEOUT, req.params.name);
                }

                const done = {
                    start: "started",
                    stop: "stopped",
                    restart: "restarted",
                }[action];
                return {
                    message: `Stack '${req.params.name}' ${done}${endpoint ? " on " + endpoint : ""}`,
                    endpoint,
                };
            }));
        }

        router.post("/api/stacks/:name/check-updates", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";

            if (endpoint === "") {
                const stack = await Stack.getStack(server, req.params.name);

                // Asked for by hand, so ask the registries rather than reuse
                // what the last check saw
                Stack.forgetRemoteImageDigests();
                await stack.refreshImageUpdateStatus();
                server.sendStackList(true);

                return {
                    imageUpdatesAvailable: stack.imageUpdatesAvailable,
                    endpoint,
                };
            }

            const res = await askAgent(server, endpoint, "checkStackImageUpdates", AGENT_ACTION_TIMEOUT, req.params.name);
            return {
                imageUpdatesAvailable: !!res.stack?.imageUpdatesAvailable,
                endpoint,
            };
        }));

        router.get("/api/stacks/:name/auto-update", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const defaultBehaviour = await AutoUpdateManager.getDefaultBehaviour();

            let stack : SimpleStackData;
            if (endpoint === "") {
                stack = (await Stack.getStack(server, req.params.name)).getSimpleData("");
            } else {
                stack = (await askAgent(server, endpoint, "updateStackData", AGENT_QUERY_TIMEOUT, req.params.name)).stack;
            }

            return {
                autoUpdate: !!stack.isManagedByDockge && resolveAutoUpdate(stack.autoUpdate ?? null, defaultBehaviour),
                policy: policyName(stack.autoUpdate),
                endpoint,
            };
        }));

        router.put("/api/stacks/:name/auto-update", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const policy = parsePolicy(req.body);

            if (endpoint === "") {
                const stack = await managedStack(server, req.params.name);
                await stack.setAutoUpdate(policy);
                server.sendStackList(true);
            } else {
                await askAgent(server, endpoint, "setStackAutoUpdate", AGENT_QUERY_TIMEOUT, req.params.name, policy);
            }

            return {
                policy: policyName(policy),
                endpoint,
            };
        }));

        // Updates across stacks

        // Answered as soon as the run has started: updating every stack can take
        // far longer than a client will wait. GET /api/scheduler says whether a
        // run is still going, and the update history what it did.
        router.post("/api/update-all", handle(async (req, res) => {
            const endpoint = await requestedEndpoint(req);
            const { prune } = pruneOptions(req.body, !!(await Settings.get("autoUpdatePrune")));

            if (endpoint !== undefined && endpoint !== "") {
                await readyAgent(server, endpoint);
                const options : AutoUpdateRunOptions = {
                    defaultBehaviour: await AutoUpdateManager.getDefaultBehaviour(),
                    pruneAfterUpdate: prune,
                    trigger: "api",
                    all: true,
                };
                askAgent(server, endpoint, "runAutoUpdate", AGENT_UPDATE_ALL_TIMEOUT, options)
                    .catch((e) => log.error("api", `Update all on ${endpoint} failed: ${e instanceof Error ? e.message : e}`));
            } else {
                const defaultBehaviour = await AutoUpdateManager.getDefaultBehaviour();

                // Checked with nothing awaited between it and runNow(), which
                // marks the run as going before it awaits anything itself: two
                // requests at once would otherwise both be told it started
                refuseIfRunning(server);

                // Without an endpoint every instance is updated, the way an
                // auto update run covers them all. With "" only this one.
                const run = endpoint === undefined
                    ? server.autoUpdateManager.runNow(undefined, {
                        trigger: "api",
                        all: true,
                        pruneAfterUpdate: prune,
                    })
                    : server.autoUpdateManager.runNow({
                        defaultBehaviour,
                        pruneAfterUpdate: prune,
                        trigger: "api",
                        all: true,
                    });
                run.catch((e) => log.error("api", `Update all failed: ${e instanceof Error ? e.message : e}`));
            }

            res.status(202);
            return {
                started: true,
                message: "Updating every running stack that is behind",
            };
        }));

        router.post("/api/system/prune", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const body = (req.body ?? {}) as LooseObject;

            // All unused images unless told otherwise, as on finder39/dockge;
            // volumes only when asked, since they hold data
            const all = body.all === undefined ? true : body.all === true;
            const volumes = body.volumes === true;

            if (endpoint === "") {
                const args = [ "system", "prune", "-f" ];
                if (all) {
                    args.push("-a");
                }
                if (volumes) {
                    args.push("--volumes");
                }
                const result = await childProcessAsync.spawn("docker", args, {
                    encoding: "utf-8",
                });
                return {
                    output: result.stdout?.toString() ?? "",
                    endpoint,
                };
            }

            const res = await askAgent(server, endpoint, "dockerSystemPrune", AGENT_ACTION_TIMEOUT, all, volumes);
            return {
                output: res.msg ?? "",
                endpoint,
            };
        }));

        // Update history

        router.get("/api/update-history", handle(async (req) => {
            const endpoint = await requestedEndpoint(req);
            const filter : UpdateHistoryFilter = {
                limit: queryNumber(req.query.limit),
                offset: queryNumber(req.query.offset),
            };

            if (typeof req.query.stack === "string" && req.query.stack !== "") {
                filter.stackName = req.query.stack;
            }
            if (typeof req.query.search === "string") {
                filter.search = req.query.search;
            }
            if (typeof req.query.trigger === "string") {
                filter.triggerType = req.query.trigger as UpdateHistoryFilter["triggerType"];
            }
            if (req.query.success === "true" || req.query.success === "false") {
                filter.success = req.query.success === "true";
            }

            const manager = await server.getApiAgentManager();
            return {
                ...await collectHistory(await historySources(manager, endpoint ?? ALL_ENDPOINTS), filter),
            };
        }));

        router.get("/api/update-history/:id", handle(async (req) => {
            const endpoint = await requestedEndpoint(req) ?? "";
            const id = Number(req.params.id);

            if (!Number.isInteger(id)) {
                throw new ApiError(400, "The ID must be an integer");
            }

            if (endpoint === "") {
                const entry = await UpdateHistory.get(id);
                if (!entry) {
                    throw new ApiError(404, "Update history entry not found");
                }
                return {
                    entry,
                };
            }

            const res = await askAgent(server, endpoint, "getUpdateHistoryEntry", AGENT_QUERY_TIMEOUT, id);
            return {
                entry: {
                    ...res.entry,
                    endpoint,
                },
            };
        }));

        // Auto update schedule

        router.get("/api/scheduler", handle(async () => {
            const status = server.getScheduleStatus();
            return {
                enabled: !!(await Settings.get("autoUpdateEnabled")),
                cronExpression: (await Settings.get("autoUpdateCron")) || AUTO_UPDATE_DEFAULT_CRON,
                defaultBehaviour: await AutoUpdateManager.getDefaultBehaviour(),
                pruneAfterUpdate: !!(await Settings.get("autoUpdatePrune")),
                pruneAllAfterUpdate: false,
                nextAutoUpdate: status.nextAutoUpdate,
                nextImageCheck: status.nextImageCheck,
                imageCheckIntervalHours: IMAGE_CHECK_INTERVAL_HOURS,
                timezone: await server.getTimezone(),
                running: server.autoUpdateManager.isRunning(),
            };
        }));

        router.put("/api/scheduler", handle(async (req) => {
            const body = (req.body ?? {}) as LooseObject;
            const data : LooseObject = {};

            if (body.enabled !== undefined) {
                if (typeof body.enabled !== "boolean") {
                    throw new ApiError(400, "enabled must be a boolean");
                }
                data.autoUpdateEnabled = body.enabled;
            }

            if (body.cronExpression !== undefined) {
                if (typeof body.cronExpression !== "string") {
                    throw new ApiError(400, "cronExpression must be a string");
                }
                try {
                    AutoUpdateManager.validateCron(body.cronExpression);
                } catch (e) {
                    throw new ApiError(400, "Invalid cron expression");
                }
                data.autoUpdateCron = body.cronExpression;
            }

            if (body.defaultBehaviour !== undefined) {
                if (body.defaultBehaviour !== "none" && body.defaultBehaviour !== "update") {
                    throw new ApiError(400, "defaultBehaviour must be \"none\" or \"update\"");
                }
                data.autoUpdateDefault = body.defaultBehaviour as AutoUpdateDefault;
            }

            if (body.pruneAfterUpdate !== undefined) {
                if (typeof body.pruneAfterUpdate !== "boolean") {
                    throw new ApiError(400, "pruneAfterUpdate must be a boolean");
                }
                data.autoUpdatePrune = body.pruneAfterUpdate;
            }

            if (Object.keys(data).length > 0) {
                await Settings.setSettings("general", data);
                await server.autoUpdateManager.schedule();
                server.sendScheduleStatus();
            }

            return {
                nextAutoUpdate: server.getScheduleStatus().nextAutoUpdate,
            };
        }));

        // Run auto update now, as "Update now" in Settings does. Answered as
        // soon as it has started, like /api/update-all.
        router.post("/api/scheduler/trigger", handle(async (_req, res) => {
            refuseIfRunning(server);

            server.autoUpdateManager.runNow(undefined, { trigger: "api" })
                .catch((e) => log.error("api", `Auto update failed: ${e instanceof Error ? e.message : e}`));

            res.status(202);
            return {
                started: true,
            };
        }));

        // Anything else under /api is not a page of the web interface
        router.use("/api", (_req, res) => {
            res.status(404).json({
                ok: false,
                error: "Not found",
            });
        });

        router.use("/api", (e : unknown, _req : Request, res : Response, _next : NextFunction) => {
            const status = (e as { status? : number }).status ?? errorStatus(e);
            if (status >= 500) {
                log.error("api", e);
            }
            res.status(status).json({
                ok: false,
                error: status === 400 && (e as { type? : string }).type === "entity.parse.failed" ? "The request body is not valid JSON" : errorMessage(e),
            });
        });

        return router;
    }
}

/**
 * Wrap a route: JSON out, errors turned into a status and an error message.
 * @param fn The route. What it returns is sent, with ok: true.
 */
function handle(fn : (req : ApiRequest, res : Response) => Promise<LooseObject>) {
    return (req : Request, res : Response) => {
        fn(req as ApiRequest, res).then((body) => {
            res.json({
                ok: true,
                ...body,
            });
        }).catch((e) => {
            const status = errorStatus(e);
            if (status >= 500) {
                log.error("api", `${req.method} ${req.path}: ${e instanceof Error ? e.message : e}`);
            }
            res.status(status).json({
                ok: false,
                error: errorMessage(e),
            });
        });
    };
}

/**
 * @param e An error
 * @returns What to tell the client about it
 */
function errorMessage(e : unknown) : string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Check the key a request was made with.
 * @param req The request
 * @param res The response
 * @param next Carries on with the request
 */
async function authenticate(req : ApiRequest, res : Response, next : NextFunction) {
    if (!await ApiKeys.anyConfigured()) {
        res.status(503).json({
            ok: false,
            error: "The REST API is off. Create an API key under Settings → API to turn it on.",
        });
        return;
    }

    const key = requestKey(req);
    const caller = key ? await ApiKeys.verify(key) : null;

    if (!caller) {
        const ip = await clientIP(req);
        if (!await authFailureLimiter.pass(() => {}, 1, ip)) {
            res.status(429).json({
                ok: false,
                error: authFailureLimiter.errorMessage,
            });
            return;
        }

        log.warn("api", `${req.method} ${req.path} with ${key ? "a wrong" : "no"} API key, IP=${ip}`);
        res.status(401).json({
            ok: false,
            error: "Invalid or missing API key",
        });
        return;
    }

    if (caller.readOnly && req.method !== "GET" && req.method !== "HEAD") {
        res.status(403).json({
            ok: false,
            error: "This API key is read-only",
        });
        return;
    }

    req.apiCaller = caller;
    next();
}

/**
 * @param req A request
 * @returns The API key it was sent with, if any
 */
function requestKey(req : Request) : string | undefined {
    const header = req.headers["x-api-key"];
    if (typeof header === "string" && header !== "") {
        return header;
    }

    const authorization = req.headers.authorization;
    if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) {
        return authorization.replace(/^Bearer\s+/i, "").trim();
    }

    return undefined;
}

/**
 * The client's address, read the same way as for a login.
 * @param req A request
 */
async function clientIP(req : Request) : Promise<string> {
    return clientIPFrom(req.socket.remoteAddress, req.headers, !!await Settings.get("trustProxy"));
}

/**
 * The instance a request is about, from ?endpoint=.
 * @param req The request
 * @returns The endpoint ("" for this instance), or undefined when the request
 * does not say
 */
async function requestedEndpoint(req : Request) : Promise<string | undefined> {
    const requested = req.query.endpoint;

    if (requested === undefined) {
        return undefined;
    }

    if (typeof requested !== "string") {
        throw new ApiError(400, "endpoint must be given once");
    }

    const agents = await agentNames();
    const endpoint = resolveEndpoint(requested, agents);

    if (endpoint === undefined) {
        throw new ApiError(404, `There is no agent "${requested}"`);
    }

    return endpoint;
}

/**
 * Every instance's endpoint and name: this one as "", then the agents.
 */
async function agentNames() : Promise<{ endpoint : string, name : string }[]> {
    const list = await Agent.getAgentList();
    const agents = Object.values(list).map((agent) => ({
        endpoint: agent.endpoint,
        name: agent.name ?? "",
    }));

    if (!agents.some((agent) => agent.endpoint === "")) {
        agents.unshift({
            endpoint: "",
            name: "",
        });
    }

    return agents;
}

/**
 * Every instance's endpoint, this one first.
 */
async function allEndpoints() : Promise<string[]> {
    return [ "", ...(await agentNames()).map((agent) => agent.endpoint).filter((endpoint) => endpoint !== "") ];
}

/**
 * The instances, as GET /api/agents sends them.
 * @param server The server
 * @param withStatus Whether to say if each is connected
 */
async function listAgents(server : DockgeServer, withStatus : boolean) {
    const manager = await server.getApiAgentManager();
    const list = await Agent.getAgentList();
    const master = Object.values(list).find((agent) => agent.endpoint === "");

    // The first request opens the connections. Until they are up, every agent
    // reads as offline with no version, so that first answer waits a moment
    // for them.
    const remaining = AGENT_LIST_WAIT - (Date.now() - manager.firstConnectTime.valueOf());
    if (remaining > 0) {
        await Promise.all(Object.values(list)
            .filter((agent) => agent.endpoint !== "" && !manager.isReady(agent.endpoint))
            .map((agent) => manager.waitUntilReady(agent.endpoint, remaining)));
    }

    const agents : LooseObject[] = [{
        endpoint: "",
        name: master?.name || "master",
        url: "",
        version: server.packageJSON.version ?? null,
        ...(withStatus ? { connected: true } : {}),
    }];

    for (const agent of Object.values(list)) {
        if (agent.endpoint === "") {
            continue;
        }
        agents.push({
            endpoint: agent.endpoint,
            name: agent.name || agent.endpoint,
            url: agent.url,
            version: manager.getAgentVersion(agent.endpoint) ?? null,
            ...(withStatus ? { connected: manager.isReady(agent.endpoint) } : {}),
        });
    }

    return agents;
}

/**
 * The stacks of one instance.
 * @param server The server
 * @param endpoint The instance
 * @param defaultBehaviour What auto update does with stacks that do not say
 */
async function stacksOf(server : DockgeServer, endpoint : string, defaultBehaviour : AutoUpdateDefault) : Promise<ApiStack[]> {
    if (endpoint === "") {
        const stackList = await Stack.getStackList(server, true);
        const stacks : ApiStack[] = [];

        for (const stack of stackList.values()) {
            await stack.loadServicesIfMissing();
            stacks.push(stackView(stack.getSimpleData(""), Object.fromEntries(stack.services), "", defaultBehaviour));
        }

        return stacks;
    }

    const res = await askAgent(server, endpoint, "getStackList", AGENT_QUERY_TIMEOUT);
    const stackList = (res.stackList ?? {}) as Record<string, SimpleStackData & { services? : Record<string, ServiceData> }>;

    return Object.values(stackList).map((stack) => stackView(stack, stack.services, endpoint, defaultBehaviour));
}

/**
 * A stack this instance manages, which is the only kind the API acts on.
 * @param server The server
 * @param name The stack
 */
async function managedStack(server : DockgeServer, name : string) : Promise<Stack> {
    const stack = await Stack.getStack(server, name);

    if (!stack.isManagedByDockge) {
        throw new ApiError(400, `Stack '${name}' is not managed by Dockge`);
    }

    return stack;
}

/**
 * The API's connection to an agent, once it is up and the agent is recent
 * enough to be driven through the API.
 * @param server The server
 * @param endpoint The agent
 */
async function readyAgent(server : DockgeServer, endpoint : string) : Promise<AgentManager> {
    const manager = await server.getApiAgentManager();

    if (!manager.isReady(endpoint) && !await manager.waitUntilReady(endpoint, AGENT_READY_TIMEOUT)) {
        throw new ApiError(502, `Agent ${endpoint} is not connected`);
    }

    const version = manager.getAgentVersion(endpoint);
    if (version && !isDev && semver.valid(version) && semver.lt(version, MIN_AGENT_VERSION_API)) {
        throw new ApiError(502, `Agent ${endpoint} runs Dockge ${version}; the REST API needs ${MIN_AGENT_VERSION_API} or newer on agents`);
    }

    return manager;
}

/**
 * Ask an agent to do something, and pass on a refusal as an error.
 * @param server The server
 * @param endpoint The agent
 * @param eventName What to ask
 * @param timeoutMs How long to wait for the answer
 * @param args The event's arguments
 * @returns The agent's answer
 */
async function askAgent(server : DockgeServer, endpoint : string, eventName : string, timeoutMs : number, ...args : unknown[]) : Promise<LooseObject> {
    const manager = await readyAgent(server, endpoint);
    const res = await manager.request(endpoint, eventName, timeoutMs, ...args);

    if (!res.ok) {
        const message = typeof res.msg === "string" ? res.msg : `${eventName} failed on ${endpoint}`;
        throw new ApiError(/not found/i.test(message) ? 404 : 502, message);
    }

    return res;
}

/**
 * Refuse a second run while one is going: the update history and the log are
 * clearer for it, and the two would only queue up behind each other anyway.
 * @param server The server
 */
function refuseIfRunning(server : DockgeServer) {
    if (server.autoUpdateManager.isRunning()) {
        throw new ApiError(409, "An update run is already going, please try again later");
    }
}

/**
 * Prune options from a request body. Off unless asked for, as in the update
 * dialog.
 * @param body The request body
 * @param defaultPrune Whether to prune when the body does not say
 */
function pruneOptions(body : unknown, defaultPrune = false) : { prune : boolean, pruneAll : boolean } {
    const data = (body && typeof body === "object" ? body : {}) as LooseObject;
    const prune = data.prune === undefined ? defaultPrune : data.prune === true;
    return {
        prune,
        pruneAll: prune && data.pruneAll === true,
    };
}

/**
 * @param value A query parameter
 * @returns It as a number, if it is one
 */
function queryNumber(value : unknown) : number | undefined {
    if (typeof value !== "string" || value === "") {
        return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
