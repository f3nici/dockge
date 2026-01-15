import { log } from "./log";
import { Settings } from "./settings";
import { NotificationSettings, NotificationEvent } from "../common/types";
import https from "https";
import http from "http";

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
                    ntfyServerUrl: settings.ntfyServerUrl ?? "https://ntfy.sh",
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
     * Save notification settings to database
     */
    async saveSettings(settings: NotificationSettings): Promise<void> {
        try {
            await Settings.setSettings("notifications", settings);
            this.settings = settings;
            log.info("notification", "Notification settings saved successfully");
        } catch (error) {
            log.error("notification", `Failed to save notification settings: ${error}`);
            throw error;
        }
    }

    /**
     * Get current notification settings
     */
    getSettings(): NotificationSettings | null {
        return this.settings;
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
            tags: ["white_check_mark"]
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
            tags: [eventInfo.emoji]
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
            tags: [eventInfo.emoji]
        };
    }

    /**
     * Send notification to NTFY server
     */
    private async sendToNtfy(message: NtfyMessage): Promise<boolean> {
        if (!this.settings) {
            return false;
        }

        const url = new URL(this.settings.ntfyTopic, this.settings.ntfyServerUrl);
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

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(postData)
                }
            };

            // Add authentication if configured
            if (this.settings!.ntfyToken) {
                options.headers!["Authorization"] = `Bearer ${this.settings!.ntfyToken}`;
            } else if (this.settings!.ntfyUsername && this.settings!.ntfyPassword) {
                const auth = Buffer.from(`${this.settings!.ntfyUsername}:${this.settings!.ntfyPassword}`).toString("base64");
                options.headers!["Authorization"] = `Basic ${auth}`;
            }

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
