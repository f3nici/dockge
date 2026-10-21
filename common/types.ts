export type StatsData = {
    cpuPerc: string,
    memUsage: string,
    memPerc: string,
    netIO: string,
    blockIO: string
}

/**
 * Resource usage of the machine an endpoint runs on, as shown next to it on the
 * dashboard. Sizes are in bytes.
 */
export type HostStatsData = {
    /**
     * How busy the CPU was over the last few seconds, averaged over all cores,
     * from 0 to 100. Null until the first measurement has been taken, or where
     * the platform does not report CPU times.
     */
    cpuPerc: number | null,
    cpuCount: number,
    memUsed: number,
    memTotal: number,
    /** The filesystem holding the stacks directory, null where it could not be read */
    diskUsed: number | null,
    diskTotal: number | null,
    diskPath: string,
}

export type ServiceData = {
    name: string,
    containerName: string,
    image: string,
    state: string,
    status: string,
    health: string,
    recreateNecessary: boolean,
    imageUpdateAvailable: boolean,
    remoteImageDigest: string,
}

/**
 * Per-stack auto update preference, read from `x-dockge.auto-update` in the
 * compose file. `null` means the key is absent, so the global default in
 * Settings decides.
 */
export type AutoUpdatePolicy = boolean | null;

/**
 * What happens to stacks that do not set `x-dockge.auto-update` themselves.
 */
export type AutoUpdateDefault = "none" | "update";

/**
 * The settings one auto update run uses. Sent to the agents so that a run
 * covers the whole fleet with the settings configured on the instance that
 * started it, instead of each agent having to be configured on its own.
 */
export type AutoUpdateRunOptions = {
    defaultBehaviour: AutoUpdateDefault,
    pruneAfterUpdate: boolean,

    /**
     * What started the run, for the update history. Agents older than 2.3.0
     * ignore it.
     */
    trigger?: UpdateTrigger,

    /**
     * Update every running stack that is behind, whether it takes part in auto
     * update or not: "Update all" rather than an auto update run. Agents older
     * than 2.3.0 ignore it, which is why they are not asked.
     */
    all?: boolean,
}

/**
 * What started an update: someone pressing Update (or "Update now" in the auto
 * update settings), the auto update schedule, or the REST API.
 */
export type UpdateTrigger = "manual" | "scheduled" | "api";

export const UPDATE_TRIGGERS: UpdateTrigger[] = [ "manual", "scheduled", "api" ];

/**
 * An update a Dockge instance ran on one of its stacks. Field names follow the
 * update history of the finder39/dockge REST API, so clients written for it
 * read this one too.
 */
export type UpdateHistoryEntry = {
    id: number,
    stackName: string,

    /** Set when only this service was updated, rather than the whole stack */
    serviceName: string | null,

    /** The instance the stack is on: "" for the one answering */
    endpoint: string,

    triggerType: UpdateTrigger | string,
    success: boolean,

    /** Only sent when a single entry is asked for */
    output?: string | null,

    errorMessage: string | null,
    startedAt: string,
    completedAt: string | null,
    durationMs: number | null,
}

export type UpdateHistoryFilter = {
    limit?: number,
    offset?: number,

    /** Exactly this stack */
    stackName?: string,

    /** Stacks whose name contains this */
    search?: string,

    triggerType?: UpdateTrigger,
    success?: boolean,
}

export type UpdateHistoryPage = {
    entries: UpdateHistoryEntry[],
    total: number,

    /** Endpoints that were asked and did not answer */
    unreachable?: string[],
}

/**
 * When an instance next does its scheduled work, as ISO timestamps. Pushed to
 * the dashboard by each instance; agents older than 2.3.0 send none.
 */
export type ScheduleStatusData = {
    nextImageCheck: string | null,
    nextAutoUpdate: string | null,
}

export type SimpleStackData = {
    name: string,
    status: number,
    started: boolean,
    recreateNecessary: boolean,
    imageUpdatesAvailable: boolean,
    tags: string[],
    autoUpdate: AutoUpdatePolicy,
    isManagedByDockge: boolean,
    composeFileName: string,
    endpoint: string
}

export type StackData = SimpleStackData & {
    composeYAML: string,
    composeENV: string,
    primaryHostname: string,
    services: Record<string, ServiceData>

    /**
     * Contents of the compose override file, and the name it has (or would be
     * given). Absent when the stack came from an agent too old to send them,
     * which is how the UI knows not to offer the override editor.
     */
    composeOverrideYAML?: string,
    composeOverrideFileName?: string,
}

export type AgentData = {
    url: string,
    username: string,
    password: string,
    endpoint: string,
    name: string
}

export enum DockerArtefactAction {
    Prune = "prune",
    PruneAll = "pruneAll",
    Remove = "remove",
    Pull = "pull"
}

export type DockerArtefactInfo = {
    name: string,
    actions: DockerArtefactAction[]
}

export const DockerArtefactInfos: Record<string, DockerArtefactInfo> = {
    Container: {
        name: "container",
        actions: [ DockerArtefactAction.Prune, DockerArtefactAction.Remove ]
    },
    Image: {
        name: "image",
        actions: [ DockerArtefactAction.Prune, DockerArtefactAction.PruneAll, DockerArtefactAction.Pull, DockerArtefactAction.Remove ]
    },
    Network: {
        name: "network",
        actions: [ DockerArtefactAction.Prune, DockerArtefactAction.Remove ]
    },
    Volume: {
        name: "volume",
        actions: [ DockerArtefactAction.Prune, DockerArtefactAction.PruneAll, DockerArtefactAction.Remove ]
    }
};

/**
 * Look up the artefact kind a request names.
 *
 * The keys of {@link DockerArtefactInfos} are capitalised while everything on
 * the wire uses the lower case `name`, so matching on the name is what actually
 * resolves. Anything not in the list is rejected rather than passed on: the
 * artefact ends up as a docker subcommand, and only these four are meant to be
 * reachable.
 * @param name Artefact name as sent by the client, e.g. "image"
 * @returns The matching info, or undefined when the name is not one of ours
 */
export function getDockerArtefactInfo(name : unknown) : DockerArtefactInfo | undefined {
    if (typeof(name) !== "string") {
        return undefined;
    }

    return Object.values(DockerArtefactInfos).find((info) => info.name === name);
}

export type DockerArtefactItem = {
    id: string,
    actionIds: Record<string, string>, // Possibly different Ids for some actions
    values: Record<string, string | [string, string] | [string, number]>, // Array if a second value for sortorder is provided
    dangling: boolean,
    danglingLabel: string,
    excludedActions: DockerArtefactAction[]
}

export type DockerArtefactData = {
    info: DockerArtefactInfo,
    data: DockerArtefactItem[]
}

export enum NotificationEvent {
    ServiceDown = "serviceDown",
    ServiceUp = "serviceUp",
    ServiceUnhealthy = "serviceUnhealthy",
    ServiceHealthy = "serviceHealthy",
    StackExited = "stackExited",
    StackRunning = "stackRunning"
}

export type NotificationSettings = {
    enabled: boolean,
    ntfyServerUrl: string,
    ntfyTopic: string,
    /** Access token. Never sent to the browser. */
    ntfyToken?: string,
    ntfyUsername?: string,
    /** Password. Never sent to the browser. */
    ntfyPassword?: string,
    enabledEvents: NotificationEvent[]
}

/**
 * The stored notification settings as the browser gets to see them: everything
 * but the secrets, plus whether a secret is on file so the form can say so.
 */
export type NotificationSettingsInfo = {
    enabled: boolean,
    ntfyServerUrl: string,
    ntfyTopic: string,
    ntfyUsername: string,
    hasNtfyToken: boolean,
    hasNtfyPassword: boolean,
    enabledEvents: NotificationEvent[]
}

/**
 * A GitHub release, as far as the "new version available" dialog cares about it.
 */
export type ReleaseInfo = {
    /** The release tag, e.g. "V1.9.0" */
    version: string,
    /** The release notes in markdown, possibly empty, possibly truncated */
    notes: string,
    /** Whether {@link notes} was cut short and the reader should follow {@link url} */
    notesTruncated: boolean,
    /** Link to the release on GitHub */
    url: string,
    /** ISO timestamp of publication, when GitHub reported one */
    publishedAt?: string,
}

/**
 * Credentials for one container registry, as stored on the server.
 */
export type RegistryCredential = {
    /** Registry host, e.g. "docker.io" or "ghcr.io" */
    registry: string,
    username: string,
    /** Password, access token or PAT. Never sent to the browser. */
    password: string,
}

/**
 * A stored credential as the browser gets to see it: everything but the secret.
 */
export type RegistryCredentialInfo = {
    registry: string,
    username: string,
}

/**
 * What a registry says about how many pulls are left. Docker Hub reports this,
 * most other registries do not.
 */
export type RegistryRateLimit = {
    /** Pulls allowed per window, or null when the registry reports no limit */
    limit: number | null,
    /** Pulls left in the current window, or null when there is no limit */
    remaining: number | null,
    /** Length of the limit window in seconds, when reported */
    windowSeconds: number | null,
    /** Whether the limit above was read while logged in */
    authenticated: boolean,
    /** The account the limit applies to, when authenticated */
    username?: string,
}

/**
 * Result of checking one set of registry credentials.
 */
export type RegistryTestResult = {
    ok: boolean,
    msg: string,
    rateLimit?: RegistryRateLimit,
}
