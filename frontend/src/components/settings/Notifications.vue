<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveNotifications">
            <!-- Enable Notifications -->
            <div class="mb-4">
                <div class="form-check form-switch">
                    <input
                        id="enableNotifications"
                        v-model="settings.enabled"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label" for="enableNotifications">
                        Enable Notifications
                    </label>
                </div>
                <div class="form-text">
                    Receive notifications when services go down, become unhealthy, or status changes occur.
                </div>
            </div>

            <div v-if="settings.enabled">
                <!-- NTFY Server URL -->
                <div class="mb-4">
                    <label class="form-label" for="ntfyServerUrl">
                        NTFY Server URL
                    </label>
                    <input
                        id="ntfyServerUrl"
                        v-model="settings.ntfyServerUrl"
                        type="text"
                        class="form-control"
                        placeholder="https://ntfy.sh"
                        required
                    />
                    <div class="form-text">
                        Use https://ntfy.sh or your self-hosted NTFY server URL
                    </div>
                </div>

                <!-- NTFY Topic -->
                <div class="mb-4">
                    <label class="form-label" for="ntfyTopic">
                        NTFY Topic
                    </label>
                    <input
                        id="ntfyTopic"
                        v-model="settings.ntfyTopic"
                        type="text"
                        class="form-control"
                        placeholder="dockge-alerts"
                        required
                    />
                    <div class="form-text">
                        The topic name to send notifications to. Subscribe to this topic in your NTFY app.
                    </div>
                </div>

                <!-- Authentication Method -->
                <div class="mb-4">
                    <label class="form-label">
                        Authentication (Optional)
                    </label>
                    <select v-model="authMethod" class="form-select mb-3">
                        <option value="none">None</option>
                        <option value="token">Access Token</option>
                        <option value="basic">Username & Password</option>
                    </select>

                    <!-- Token Auth -->
                    <div v-if="authMethod === 'token'" class="mb-3">
                        <label class="form-label" for="ntfyToken">
                            Access Token
                        </label>
                        <input
                            id="ntfyToken"
                            v-model="ntfyTokenInput"
                            type="password"
                            class="form-control"
                            autocomplete="new-password"
                            :placeholder="hasNtfyToken ? 'Leave blank to keep the stored token' : 'tk_...'"
                        />
                        <div class="form-text">
                            NTFY access token for authentication
                        </div>
                    </div>

                    <!-- Basic Auth -->
                    <div v-if="authMethod === 'basic'">
                        <div class="mb-3">
                            <label class="form-label" for="ntfyUsername">
                                Username
                            </label>
                            <input
                                id="ntfyUsername"
                                v-model="settings.ntfyUsername"
                                type="text"
                                class="form-control"
                            />
                        </div>
                        <div class="mb-3">
                            <label class="form-label" for="ntfyPassword">
                                Password
                            </label>
                            <input
                                id="ntfyPassword"
                                v-model="ntfyPasswordInput"
                                type="password"
                                class="form-control"
                                autocomplete="new-password"
                                :placeholder="hasNtfyPassword ? 'Leave blank to keep the stored password' : ''"
                            />
                        </div>
                    </div>
                </div>

                <!-- Event Selection -->
                <div class="mb-4">
                    <label class="form-label">
                        Notification Events
                    </label>
                    <div class="form-text mb-2">
                        Select which events should trigger notifications
                    </div>

                    <div class="form-check">
                        <input
                            id="eventServiceDown"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="serviceDown"
                        />
                        <label class="form-check-label" for="eventServiceDown">
                            Service Down - When a service stops or exits
                        </label>
                    </div>

                    <div class="form-check">
                        <input
                            id="eventServiceUp"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="serviceUp"
                        />
                        <label class="form-check-label" for="eventServiceUp">
                            Service Up - When a service starts running
                        </label>
                    </div>

                    <div class="form-check">
                        <input
                            id="eventServiceUnhealthy"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="serviceUnhealthy"
                        />
                        <label class="form-check-label" for="eventServiceUnhealthy">
                            Service Unhealthy - When a health check fails
                        </label>
                    </div>

                    <div class="form-check">
                        <input
                            id="eventServiceHealthy"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="serviceHealthy"
                        />
                        <label class="form-check-label" for="eventServiceHealthy">
                            Service Healthy - When a service becomes healthy again
                        </label>
                    </div>

                    <div class="form-check">
                        <input
                            id="eventStackExited"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="stackExited"
                        />
                        <label class="form-check-label" for="eventStackExited">
                            Stack Exited - When an entire stack stops
                        </label>
                    </div>

                    <div class="form-check">
                        <input
                            id="eventStackRunning"
                            v-model="settings.enabledEvents"
                            class="form-check-input"
                            type="checkbox"
                            value="stackRunning"
                        />
                        <label class="form-check-label" for="eventStackRunning">
                            Stack Running - When an entire stack starts
                        </label>
                    </div>
                </div>
            </div>

            <!-- Buttons -->
            <div>
                <button class="btn btn-primary me-2" type="submit">
                    Save
                </button>
                <button
                    v-if="settings.enabled"
                    class="btn btn-secondary"
                    type="button"
                    :disabled="testingNotification"
                    @click="testNotification"
                >
                    <span v-if="testingNotification">Sending...</span>
                    <span v-else>Test Notification</span>
                </button>
            </div>

            <!-- Test Result -->
            <div v-if="testResult" class="mt-3">
                <div :class="['alert', testResult.success ? 'alert-success' : 'alert-danger']" role="alert">
                    {{ testResult.message }}
                </div>
            </div>
        </form>
    </div>
</template>

<script>
export default {
    data() {
        return {
            settings: {
                enabled: false,
                ntfyServerUrl: "https://ntfy.sh",
                ntfyTopic: "",
                ntfyUsername: "",
                enabledEvents: []
            },
            // Kept apart from settings: the server never sends the secrets, so a
            // blank box means "unchanged" rather than "empty" whenever one is
            // already stored.
            ntfyTokenInput: "",
            ntfyPasswordInput: "",
            hasNtfyToken: false,
            hasNtfyPassword: false,
            authMethod: "none",
            testingNotification: false,
            testResult: null
        };
    },

    mounted() {
        this.loadSettings();
    },

    methods: {
        async loadSettings() {
            this.$root.getSocket().emit("getNotificationSettings", (res) => {
                if (res.ok) {
                    this.settings = {
                        enabled: res.data.enabled,
                        ntfyServerUrl: res.data.ntfyServerUrl,
                        ntfyTopic: res.data.ntfyTopic,
                        ntfyUsername: res.data.ntfyUsername,
                        enabledEvents: res.data.enabledEvents,
                    };

                    this.hasNtfyToken = res.data.hasNtfyToken;
                    this.hasNtfyPassword = res.data.hasNtfyPassword;
                    this.ntfyTokenInput = "";
                    this.ntfyPasswordInput = "";

                    // Determine auth method
                    if (this.hasNtfyToken) {
                        this.authMethod = "token";
                    } else if (this.settings.ntfyUsername) {
                        this.authMethod = "basic";
                    } else {
                        this.authMethod = "none";
                    }
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        async saveNotifications() {
            const payload = {
                enabled: this.settings.enabled,
                ntfyServerUrl: this.settings.ntfyServerUrl,
                ntfyTopic: this.settings.ntfyTopic,
                enabledEvents: this.settings.enabledEvents,
            };

            // An omitted secret keeps the stored one, an empty string clears it,
            // so the auth method decides which of the two each field gets. Only
            // the fields the chosen method uses can survive.
            if (this.authMethod === "token") {
                payload.ntfyUsername = "";
                payload.ntfyPassword = "";
                if (this.ntfyTokenInput || !this.hasNtfyToken) {
                    payload.ntfyToken = this.ntfyTokenInput;
                }
            } else if (this.authMethod === "basic") {
                payload.ntfyToken = "";
                payload.ntfyUsername = this.settings.ntfyUsername;
                if (this.ntfyPasswordInput || !this.hasNtfyPassword) {
                    payload.ntfyPassword = this.ntfyPasswordInput;
                }
            } else {
                payload.ntfyToken = "";
                payload.ntfyUsername = "";
                payload.ntfyPassword = "";
            }

            this.$root.getSocket().emit("saveNotificationSettings", payload, (res) => {
                if (res.ok) {
                    this.$root.toastSuccess(res.msg);
                    // Pick up which secrets are on file now
                    this.loadSettings();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        async testNotification() {
            this.testingNotification = true;
            this.testResult = null;

            this.$root.getSocket().emit("testNotification", (res) => {
                this.testingNotification = false;

                if (res.ok) {
                    this.testResult = {
                        success: true,
                        message: res.msg
                    };
                } else {
                    this.testResult = {
                        success: false,
                        message: res.msg
                    };
                }

                // Clear test result after 5 seconds
                setTimeout(() => {
                    this.testResult = null;
                }, 5000);
            });
        }
    }
};
</script>

<style scoped>
.form-check {
    margin-bottom: 0.5rem;
}
</style>
