export type StatsData = {
    cpuPerc: string,
    memUsage: string,
    memPerc: string,
    netIO: string,
    blockIO: string
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
    ntfyToken?: string,
    ntfyUsername?: string,
    ntfyPassword?: string,
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
