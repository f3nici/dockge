import { log } from "./log";
import { Settings } from "./settings";
import { NotificationSettings, NotificationSettingsInfo, NotificationEvent } from "../common/types";
import https from "https";
import http from "http";

/** Where notifications go when nothing else is configured */
export const DEFAULT_NTFY_SERVER_URL = "https://ntfy.sh";

/**
 * Check that a server URL is a well-formed http(s) URL.
 *
 * Rejects other schemes (file:, gopher:, ...) that could be abused. An empty
 * URL is left alone; nothing is sent until one is configured.
 * @param serverUrl The URL to check
 */
export function assertValidNtfyServerUrl(serverUrl: string | undefined): void {
    if (!serverUrl) {
        return;
    }

    let url: URL;

    try {
        url = new URL(serverUrl);
    } catch (e) {
        throw new Error("Invalid NTFY server URL");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("NTFY server URL must use http or https");
    }
}

/**
 * Turn whatever the browser sent into settings worth storing.
 *
 * A secret is only replaced when the payload carries one: the browser is never
 * given the stored token or password, so an absent field means "leave it as it
 * is" and an empty string means "clear it".
 * @param input The settings as received from the client
 * @param previous The settings currently in force, for the secrets
 * @returns The settings to store
 */
export function normalizeNotificationSettings(input: unknown, previous: NotificationSettings | null): NotificationSettings {
    if (!input || typeof(input) !== "object" || Array.isArray(input)) {
        throw new Error("Notification settings must be an object");
    }

    const raw = input as Record<string, unknown>;

    if (typeof(raw.enabled) !== "boolean") {
        throw new Error("\"enabled\" must be true or false");
    }

    if (raw.ntfyServerUrl !== undefined && typeof(raw.ntfyServerUrl) !== "string") {
        throw new Error("The NTFY server URL must be a string");
    }

    if (raw.ntfyTopic !== undefined && typeof(raw.ntfyTopic) !== "string") {
        throw new Error("The NTFY topic must be a string");
    }

    const ntfyServerUrl = ((raw.ntfyServerUrl as string | undefined) ?? DEFAULT_NTFY_SERVER_URL).trim();
    const ntfyTopic = ((raw.ntfyTopic as string | undefined) ?? "").trim();

    assertValidNtfyServerUrl(ntfyServerUrl);

    // Enabled but with nowhere to publish to would simply never notify, which
    // looks like a broken feature rather than a half-filled form
    if (raw.enabled && (!ntfyServerUrl || !ntfyTopic)) {
        throw new Error("A NTFY server URL and topic are required to enable notifications");
    }

    if (!Array.isArray(raw.enabledEvents)) {
        throw new Error("\"enabledEvents\" must be a list");
    }

    const knownEvents = Object.values(NotificationEvent) as string[];
    const enabledEvents: NotificationEvent[] = [];

    for (const event of raw.enabledEvents) {
        if (typeof(event) !== "string" || !knownEvents.includes(event)) {
            throw new Error(`Unknown notification event "${event}"`);
        }

        if (!enabledEvents.includes(event as NotificationEvent)) {
            enabledEvents.push(event as NotificationEvent);
        }
    }

    return {
        enabled: raw.enabled,
        ntfyServerUrl,
        ntfyTopic,
        ntfyToken: readSecret(raw, "ntfyToken", previous?.ntfyToken),
        ntfyUsername: readOptionalString(raw, "ntfyUsername", previous?.ntfyUsername),
        ntfyPassword: readSecret(raw, "ntfyPassword", previous?.ntfyPassword),
        enabledEvents,
    };
}

/**
 * Read a secret the browser may have left out, meaning "keep what is stored".
 * @param raw The payload
 * @param key Which secret
 * @param stored The secret currently in force
 */
function readSecret(raw: Record<string, unknown>, key: string, stored: string | undefined): string {
    if (raw[key] === undefined) {
        return stored ?? "";
    }

    if (typeof(raw[key]) !== "string") {
        throw new Error(`"${key}" must be a string`);
    }

    return raw[key] as string;
}

/**
 * Read a non-secret string, falling back to what is stored when it is absent.
 * @param raw The payload
 * @param key Which field
 * @param stored The value currently in force
 */
function readOptionalString(raw: Record<string, unknown>, key: string, stored: string | undefined): string {
    if (raw[key] === undefined) {
        return stored ?? "";
    }

    if (typeof(raw[key]) !== "string") {
        throw new Error(`"${key}" must be a string`);
    }

    return (raw[key] as string).trim();
}

export class NotificationManager {
    private settings: NotificationSettings | null = null;
    private lastNotificationTime: Map<string, number> = new Map();
    private readonly RATE_LIMIT_MS = 60000; // 1 minute between duplicate notifications

    constructor() {
        // Settings will be loaded by calling loadSettings() explicitly after database is ready
    }

    /**
     * Load notification settings from database
     */
    async loadSettings(): Promise<void> {
        try {
            const settings = await Settings.getSettings("notifications");

            if (settings && Object.keys(settings).length > 0) {
                this.settings = {
                    enabled: settings.enabled ?? false,
                    ntfyServerUrl: settings.ntfyServerUrl ?? DEFAULT_NTFY_SERVER_URL,
                    ntfyTopic: settings.ntfyTopic ?? "",
                    ntfyToken: settings.ntfyToken,
                    ntfyUsername: settings.ntfyUsername,
                    ntfyPassword: settings.ntfyPassword,
                    enabledEvents: settings.enabledEvents ?? []
                };
                log.info("notification", "Notification settings loaded successfully");
            } else {
                log.debug("notification", "No notification settings found, notifications disabled");
                this.settings = null;
            }
        } catch (error) {
            log.error("notification", `Failed to load notification settings: ${error}`);
            this.settings = null;
        }
    }

    /**
     * Save notification settings to database.
     *
     * The payload comes straight off a socket, so it is checked and normalised
     * rather than stored as it arrives. A secret the browser left out is kept
     * as it was: it is never sent out in the first place, so the form has
     * nothing to send back.
     * @param input The settings as received from the client
     */
    async saveSettings(input: unknown): Promise<void> {
        try {
            const settings = normalizeNotificationSettings(input, this.settings);
            await Settings.setSettings("notifications", settings);
            this.settings = settings;
            log.info("notification", "Notification settings saved successfully");
        } catch (error) {
            log.error("notification", `Failed to save notification settings: ${error}`);
            throw error;
        }
    }

    /**
     * The stored settings without their secrets, for the browser.
     *
     * The token and password stay on the server: the form reports whether one
     * is stored and sends a replacement only when the user types one.
     */
    getSettingsForClient(): NotificationSettingsInfo {
        const settings = this.settings;

        return {
            enabled: settings?.enabled ?? false,
            ntfyServerUrl: settings?.ntfyServerUrl ?? DEFAULT_NTFY_SERVER_URL,
            ntfyTopic: settings?.ntfyTopic ?? "",
            ntfyUsername: settings?.ntfyUsername ?? "",
            hasNtfyToken: !!settings?.ntfyToken,
            hasNtfyPassword: !!settings?.ntfyPassword,
            enabledEvents: settings?.enabledEvents ?? [],
        };
    }

    /**
     * Test notification by sending a test message
     */
    async testNotification(): Promise<boolean> {
        if (!this.settings || !this.settings.ntfyServerUrl || !this.settings.ntfyTopic) {
            throw new Error("Notification settings not configured");
        }

        const message = {
            title: "Dockge Test Notification",
            message: "Your NTFY integration is working correctly!",
            priority: 3,
            tags: [ "white_check_mark" ]
        };

        return await this.sendToNtfy(message);
    }

    /**
     * Send notification for service state change
     */
    async notifyServiceChange(
        stackName: string,
        serviceName: string,
        event: NotificationEvent,
        details?: string
    ): Promise<void> {
        if (!this.shouldNotify(event)) {
            return;
        }

        const notificationKey = `${stackName}:${serviceName}:${event}`;
        if (this.isRateLimited(notificationKey)) {
            log.debug("notification", `Rate limited notification for ${notificationKey}`);
            return;
        }

        const message = this.buildServiceMessage(stackName, serviceName, event, details);
        const sent = await this.sendToNtfy(message);

        if (sent) {
            this.lastNotificationTime.set(notificationKey, Date.now());
        }
    }

    /**
     * Send notification for stack state change
     */
    async notifyStackChange(
        stackName: string,
        event: NotificationEvent,
        details?: string
    ): Promise<void> {
        if (!this.shouldNotify(event)) {
            return;
        }

        const notificationKey = `${stackName}:${event}`;
        if (this.isRateLimited(notificationKey)) {
            log.debug("notification", `Rate limited notification for ${notificationKey}`);
            return;
        }

        const message = this.buildStackMessage(stackName, event, details);
        const sent = await this.sendToNtfy(message);

        if (sent) {
            this.lastNotificationTime.set(notificationKey, Date.now());
        }
    }

    /**
     * Check if notification should be sent based on settings
     */
    private shouldNotify(event: NotificationEvent): boolean {
        if (!this.settings || !this.settings.enabled) {
            return false;
        }

        if (!this.settings.ntfyServerUrl || !this.settings.ntfyTopic) {
            log.debug("notification", "NTFY server URL or topic not configured");
            return false;
        }

        if (!this.settings.enabledEvents.includes(event)) {
            log.debug("notification", `Event ${event} not enabled in settings`);
            return false;
        }

        return true;
    }

    /**
     * Check if notification is rate limited
     */
    private isRateLimited(key: string): boolean {
        const lastTime = this.lastNotificationTime.get(key);
        if (!lastTime) {
            return false;
        }

        return Date.now() - lastTime < this.RATE_LIMIT_MS;
    }

    /**
     * Build notification message for service change
     */
    private buildServiceMessage(
        stackName: string,
        serviceName: string,
        event: NotificationEvent,
        details?: string
    ): NtfyMessage {
        const eventMap: Record<NotificationEvent, { title: string, message: string, emoji: string, priority: number }> = {
            [NotificationEvent.ServiceDown]: {
                title: "Service Down",
                message: "has stopped",
                emoji: "red_circle",
                priority: 4
            },
            [NotificationEvent.ServiceUp]: {
                title: "Service Up",
                message: "is now running",
                emoji: "green_circle",
                priority: 3
            },
            [NotificationEvent.ServiceUnhealthy]: {
                title: "Service Unhealthy",
                message: "health check failed",
                emoji: "warning",
                priority: 4
            },
            [NotificationEvent.ServiceHealthy]: {
                title: "Service Healthy",
                message: "is now healthy",
                emoji: "white_check_mark",
                priority: 3
            },
            [NotificationEvent.StackExited]: {
                title: "Stack Exited",
                message: "has stopped",
                emoji: "x",
                priority: 4
            },
            [NotificationEvent.StackRunning]: {
                title: "Stack Running",
                message: "is now running",
                emoji: "rocket",
                priority: 3
            }
        };

        const eventInfo = eventMap[event];
        let message = `Service "${serviceName}" in stack "${stackName}" ${eventInfo.message}`;
        if (details) {
            message += `\n\n${details}`;
        }

        return {
            title: `[Dockge] ${eventInfo.title}`,
            message: message,
            priority: eventInfo.priority,
            tags: [ eventInfo.emoji ]
        };
    }

    /**
     * Build notification message for stack change
     */
    private buildStackMessage(
        stackName: string,
        event: NotificationEvent,
        details?: string
    ): NtfyMessage {
        const eventMap: Record<NotificationEvent, { title: string, message: string, emoji: string, priority: number }> = {
            [NotificationEvent.ServiceDown]: {
                title: "Service Down",
                message: "has services that stopped",
                emoji: "red_circle",
                priority: 4
            },
            [NotificationEvent.ServiceUp]: {
                title: "Service Up",
                message: "has services running",
                emoji: "green_circle",
                priority: 3
            },
            [NotificationEvent.ServiceUnhealthy]: {
                title: "Service Unhealthy",
                message: "has unhealthy services",
                emoji: "warning",
                priority: 4
            },
            [NotificationEvent.ServiceHealthy]: {
                title: "Service Healthy",
                message: "all services are healthy",
                emoji: "white_check_mark",
                priority: 3
            },
            [NotificationEvent.StackExited]: {
                title: "Stack Exited",
                message: "has stopped",
                emoji: "x",
                priority: 4
            },
            [NotificationEvent.StackRunning]: {
                title: "Stack Running",
                message: "is now running",
                emoji: "rocket",
                priority: 3
            }
        };

        const eventInfo = eventMap[event];
        let message = `Stack "${stackName}" ${eventInfo.message}`;
        if (details) {
            message += `\n\n${details}`;
        }

        return {
            title: `[Dockge] ${eventInfo.title}`,
            message: message,
            priority: eventInfo.priority,
            tags: [ eventInfo.emoji ]
        };
    }

    /**
     * Send notification to NTFY server
     */
    private async sendToNtfy(message: NtfyMessage): Promise<boolean> {
        if (!this.settings) {
            return false;
        }

        // For JSON publishing, POST to the server root URL, not to the topic path
        assertValidNtfyServerUrl(this.settings.ntfyServerUrl);
        const url = new URL(this.settings.ntfyServerUrl);
        const isHttps = url.protocol === "https:";
        const httpModule = isHttps ? https : http;

        return new Promise((resolve) => {
            const postData = JSON.stringify({
                topic: this.settings!.ntfyTopic,
                title: message.title,
                message: message.message,
                priority: message.priority,
                tags: message.tags
            });

            const headers: http.OutgoingHttpHeaders = {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData)
            };

            // Add authentication if configured
            if (this.settings!.ntfyToken) {
                headers["Authorization"] = `Bearer ${this.settings!.ntfyToken}`;
            } else if (this.settings!.ntfyUsername && this.settings!.ntfyPassword) {
                const auth = Buffer.from(`${this.settings!.ntfyUsername}:${this.settings!.ntfyPassword}`).toString("base64");
                headers["Authorization"] = `Basic ${auth}`;
            }

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: "/",  // Always POST to root for JSON publishing
                method: "POST",
                family: 4,  // Force IPv4
                headers
            };

            const req = httpModule.request(options, (res) => {
                let data = "";

                res.on("data", (chunk) => {
                    data += chunk;
                });

                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        log.info("notification", `Notification sent successfully: ${message.title}`);
                        resolve(true);
                    } else {
                        log.error("notification", `Failed to send notification. Status: ${res.statusCode}, Response: ${data}`);
                        resolve(false);
                    }
                });
            });

            req.on("error", (error) => {
                log.error("notification", `Error sending notification: ${error.message}`);
                resolve(false);
            });

            req.write(postData);
            req.end();
        });
    }
}

interface NtfyMessage {
    title: string;
    message: string;
    priority: number;
    tags: string[];
}
