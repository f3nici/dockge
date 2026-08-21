import { describe, it, expect } from "vitest";
import {
    DEFAULT_NTFY_SERVER_URL,
    assertValidNtfyServerUrl,
    normalizeNotificationSettings,
} from "../backend/notification-manager";
import { NotificationEvent, NotificationSettings } from "../common/types";

const stored : NotificationSettings = {
    enabled: true,
    ntfyServerUrl: "https://ntfy.example.com",
    ntfyTopic: "dockge",
    ntfyToken: "tk_stored",
    ntfyUsername: "someone",
    ntfyPassword: "stored-password",
    enabledEvents: [ NotificationEvent.ServiceDown ],
};

const minimal = {
    enabled: false,
    ntfyServerUrl: "https://ntfy.sh",
    ntfyTopic: "topic",
    enabledEvents: [],
};

describe("assertValidNtfyServerUrl", () => {
    it("accepts http and https", () => {
        expect(() => assertValidNtfyServerUrl("http://ntfy.lan")).not.toThrow();
        expect(() => assertValidNtfyServerUrl("https://ntfy.sh")).not.toThrow();
    });

    it("accepts an empty url, since nothing is sent until one is set", () => {
        expect(() => assertValidNtfyServerUrl("")).not.toThrow();
        expect(() => assertValidNtfyServerUrl(undefined)).not.toThrow();
    });

    it("rejects other schemes", () => {
        expect(() => assertValidNtfyServerUrl("file:///etc/passwd")).toThrow(/http or https/);
    });

    it("rejects something that is not a url at all", () => {
        expect(() => assertValidNtfyServerUrl("not a url")).toThrow(/Invalid NTFY server URL/);
    });
});

describe("normalizeNotificationSettings", () => {
    describe("secrets", () => {
        it("keeps the stored token when the payload leaves it out", () => {
            const result = normalizeNotificationSettings(minimal, stored);
            expect(result.ntfyToken).toBe("tk_stored");
            expect(result.ntfyPassword).toBe("stored-password");
        });

        it("replaces a secret the payload carries", () => {
            const result = normalizeNotificationSettings({ ...minimal,
                ntfyToken: "tk_new" }, stored);
            expect(result.ntfyToken).toBe("tk_new");
        });

        it("clears a secret on an explicit empty string", () => {
            const result = normalizeNotificationSettings({ ...minimal,
                ntfyToken: "",
                ntfyPassword: "" }, stored);
            expect(result.ntfyToken).toBe("");
            expect(result.ntfyPassword).toBe("");
        });

        it("has no secret to keep when nothing is stored yet", () => {
            const result = normalizeNotificationSettings(minimal, null);
            expect(result.ntfyToken).toBe("");
            expect(result.ntfyPassword).toBe("");
        });

        it("rejects a secret that is not a string", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                ntfyToken: 1234 }, stored)).toThrow(/ntfyToken/);
        });
    });

    describe("validation", () => {
        it("rejects a payload that is not an object", () => {
            expect(() => normalizeNotificationSettings("nope", null)).toThrow(/must be an object/);
            expect(() => normalizeNotificationSettings([], null)).toThrow(/must be an object/);
            expect(() => normalizeNotificationSettings(null, null)).toThrow(/must be an object/);
        });

        it("requires enabled to be a boolean", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                enabled: "yes" }, null)).toThrow(/true or false/);
        });

        it("validates the server url even when notifications are off", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                enabled: false,
                ntfyServerUrl: "javascript:alert(1)" }, null)).toThrow(/http or https/);
        });

        it("requires a url and a topic to enable notifications", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                enabled: true,
                ntfyTopic: "" }, null)).toThrow(/required to enable/);
        });

        it("requires enabledEvents to be a list", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                enabledEvents: "serviceDown" }, null)).toThrow(/must be a list/);
        });

        it("rejects an unknown event", () => {
            expect(() => normalizeNotificationSettings({ ...minimal,
                enabledEvents: [ "somethingElse" ] }, null)).toThrow(/Unknown notification event/);
        });

        it("keeps known events and drops duplicates", () => {
            const result = normalizeNotificationSettings({
                ...minimal,
                enabledEvents: [ NotificationEvent.ServiceUp, NotificationEvent.ServiceUp, NotificationEvent.StackExited ],
            }, null);
            expect(result.enabledEvents).toEqual([ NotificationEvent.ServiceUp, NotificationEvent.StackExited ]);
        });
    });

    describe("normalisation", () => {
        it("trims the url, topic and username", () => {
            const result = normalizeNotificationSettings({
                ...minimal,
                ntfyServerUrl: "  https://ntfy.sh  ",
                ntfyTopic: "  topic  ",
                ntfyUsername: "  someone  ",
            }, null);
            expect(result.ntfyServerUrl).toBe("https://ntfy.sh");
            expect(result.ntfyTopic).toBe("topic");
            expect(result.ntfyUsername).toBe("someone");
        });

        it("falls back to the default server url", () => {
            const result = normalizeNotificationSettings({
                enabled: false,
                ntfyTopic: "",
                enabledEvents: [],
            }, null);
            expect(result.ntfyServerUrl).toBe(DEFAULT_NTFY_SERVER_URL);
        });
    });
});
