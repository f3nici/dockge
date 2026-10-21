import { AutoUpdateDefault, AutoUpdatePolicy, ServiceData, SimpleStackData } from "../common/types";
import { CREATED_FILE, CREATED_STACK, EXITED, resolveAutoUpdate, RUNNING, RUNNING_AND_EXITED, UNHEALTHY, UNKNOWN } from "../common/util-common";
import { ValidationError } from "./util-server";
import { SelfStackError } from "./self-stack";
import { AgentDisconnectedError, AgentTimeoutError } from "./agent-manager";

/**
 * How the REST API shapes what it sends. The names and fields follow the REST
 * API of finder39/dockge, so that clients written for it - its Home Assistant
 * integration in particular - work against this one as well.
 */

export const STATUS_NAMES : Record<number, string> = {
    [UNKNOWN]: "unknown",
    [CREATED_FILE]: "created_file",
    [CREATED_STACK]: "created_stack",
    [RUNNING]: "running",
    [EXITED]: "exited",
    [RUNNING_AND_EXITED]: "running_and_exited",
    [UNHEALTHY]: "unhealthy",
};

export type AutoUpdatePolicyName = "always" | "never" | "inherit";

export interface ApiService {
    name : string;
    containerName : string;
    image : string;
    state : string;
    status : string;
    health : string;
    imageUpdateAvailable : boolean;
    recreateNecessary : boolean;
}

export interface ApiStack {
    name : string;
    status : string;
    statusCode : number;
    started : boolean;
    isManagedByDockge : boolean;
    endpoint : string;

    /** Whether auto update will update this stack, whichever way that was decided */
    autoUpdate : boolean;

    /** What the stack's compose file says: always, never, or follow the default */
    autoUpdatePolicy : AutoUpdatePolicyName;

    imageUpdatesAvailable : boolean;
    recreateNecessary : boolean;
    tags : string[];
    services : Record<string, ApiService>;
}

/**
 * @param policy A stack's x-dockge.auto-update
 * @returns Its name in the API
 */
export function policyName(policy : AutoUpdatePolicy | undefined) : AutoUpdatePolicyName {
    if (policy === true) {
        return "always";
    }
    if (policy === false) {
        return "never";
    }
    return "inherit";
}

/**
 * Read an auto update setting from a request body: `{ "enabled": true }`, as
 * Home Assistant sends it, or `{ "policy": "inherit" }`.
 * @param body The request body
 * @returns The policy to write
 */
export function parsePolicy(body : unknown) : AutoUpdatePolicy {
    const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

    if ("policy" in data) {
        switch (data.policy) {
            case "always": return true;
            case "never": return false;
            case "inherit": return null;
        }
        throw new ValidationError("policy must be \"always\", \"never\" or \"inherit\"");
    }

    if (data.enabled === true || data.enabled === false || data.enabled === null) {
        return data.enabled;
    }

    throw new ValidationError("Send { \"enabled\": true | false | null } or { \"policy\": \"always\" | \"never\" | \"inherit\" }");
}

/**
 * @param service A service as Dockge keeps it
 * @returns The service as the API sends it
 */
export function serviceView(service : ServiceData) : ApiService {
    return {
        name: service.name,
        containerName: service.containerName,
        image: service.image,
        state: service.state,
        status: service.status,
        health: service.health,
        imageUpdateAvailable: !!service.imageUpdateAvailable,
        recreateNecessary: !!service.recreateNecessary,
    };
}

/**
 * @param stack A stack as Dockge sends it to the browser
 * @param services Its services
 * @param endpoint The instance it is on
 * @param defaultBehaviour What auto update does with stacks that do not say:
 * the master's, since its runs cover every agent too
 * @returns The stack as the API sends it
 */
export function stackView(stack : SimpleStackData, services : Record<string, ServiceData> | undefined, endpoint : string, defaultBehaviour : AutoUpdateDefault) : ApiStack {
    return {
        name: stack.name,
        status: STATUS_NAMES[stack.status] ?? "unknown",
        statusCode: stack.status,
        started: !!stack.started,
        isManagedByDockge: !!stack.isManagedByDockge,
        endpoint,
        autoUpdate: !!stack.isManagedByDockge && resolveAutoUpdate(stack.autoUpdate ?? null, defaultBehaviour),
        autoUpdatePolicy: policyName(stack.autoUpdate),
        imageUpdatesAvailable: !!stack.imageUpdatesAvailable,
        recreateNecessary: !!stack.recreateNecessary,
        tags: stack.tags ?? [],
        services: Object.fromEntries(Object.entries(services ?? {}).map(([ name, service ]) => [ name, serviceView(service) ])),
    };
}

/**
 * Work out which instance a request means.
 * @param requested The endpoint query parameter: an endpoint, or an agent's
 * name, as finder39/dockge also takes. "" is this instance.
 * @param agents Every agent's endpoint and name; "" for this instance
 * @returns The endpoint, or undefined when there is no such instance
 */
export function resolveEndpoint(requested : string, agents : { endpoint : string, name : string }[]) : string | undefined {
    if (requested === "") {
        return "";
    }

    const byEndpoint = agents.find((agent) => agent.endpoint === requested);
    if (byEndpoint) {
        return byEndpoint.endpoint;
    }

    const lower = requested.toLowerCase();
    const byName = agents.find((agent) => agent.name !== "" && agent.name.toLowerCase() === lower);
    if (byName) {
        return byName.endpoint;
    }

    if (lower === "master") {
        return "";
    }

    return undefined;
}

/**
 * The HTTP status an error stands for.
 * @param e The error
 */
export function errorStatus(e : unknown) : number {
    if (e instanceof ApiError) {
        return e.status;
    }
    if (e instanceof SelfStackError) {
        return 409;
    }
    if (e instanceof AgentTimeoutError) {
        return 504;
    }
    if (e instanceof AgentDisconnectedError) {
        return 502;
    }
    if (e instanceof ValidationError) {
        return /not found/i.test(e.message) ? 404 : 400;
    }
    if (e instanceof Error && /already running/i.test(e.message)) {
        return 409;
    }
    return 500;
}

/**
 * An error that says which HTTP status to answer with.
 */
export class ApiError extends Error {
    constructor(public status : number, message : string) {
        super(message);
    }
}
