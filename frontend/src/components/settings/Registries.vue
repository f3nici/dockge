<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="save">
            <p class="form-text">{{ $t("registryCredentialsDescription") }}</p>

            <!-- Docker Hub pull limit -->
            <div class="mb-4 rate-limit">
                <div class="d-flex justify-content-between align-items-center">
                    <strong>{{ $t("dockerHubRateLimit") }}</strong>
                    <button class="btn btn-sm btn-outline-primary" type="button" :disabled="rateLimitLoading" @click="loadRateLimit">
                        <font-awesome-icon icon="arrows-rotate" :spin="rateLimitLoading" />
                        {{ $t("registryRefresh") }}
                    </button>
                </div>

                <div v-if="rateLimitError" class="form-text text-danger">{{ rateLimitError }}</div>

                <template v-else-if="rateLimit">
                    <div class="form-text mb-0">
                        <template v-if="rateLimit.limit !== null">
                            {{ $t("dockerHubRateLimitRemaining", {
                                remaining: rateLimit.remaining ?? "?",
                                limit: rateLimit.limit,
                                window: rateLimitWindow,
                            }) }}
                        </template>
                        <template v-else>
                            {{ $t("dockerHubRateLimitUnlimited") }}
                        </template>
                    </div>
                    <div class="form-text mt-0">
                        <template v-if="rateLimit.authenticated">
                            {{ $t("dockerHubRateLimitAuthenticated", { username: rateLimit.username ?? "" }) }}
                        </template>
                        <template v-else>
                            {{ $t("dockerHubRateLimitAnonymous") }}
                        </template>
                    </div>
                </template>

                <div v-else class="form-text">{{ $t("registryLoading") }}</div>
            </div>

            <!-- Stored logins -->
            <div v-if="credentials.length === 0" class="form-text mb-3">
                {{ $t("registryNoCredentials") }}
            </div>

            <div v-for="(credential, index) in credentials" :key="index" class="mb-4 credential">
                <div class="mb-2">
                    <label class="form-label" :for="`registry-${index}`">{{ $t("registryHost") }}</label>
                    <input
                        :id="`registry-${index}`"
                        v-model="credential.registry"
                        class="form-control"
                        placeholder="docker.io"
                        required
                    />
                </div>

                <div class="mb-2">
                    <label class="form-label" :for="`registry-username-${index}`">{{ $t("registryUsername") }}</label>
                    <input
                        :id="`registry-username-${index}`"
                        v-model="credential.username"
                        class="form-control"
                        autocomplete="off"
                        required
                    />
                </div>

                <div class="mb-2">
                    <label class="form-label">{{ $t("registryPassword") }}</label>
                    <HiddenInput
                        v-model="credential.password"
                        :placeholder="credential.stored ? $t('registryPasswordUnchanged') : ''"
                        :required="!credential.stored"
                        autocomplete="new-password"
                    />
                    <div class="form-text">{{ $t("registryPasswordHint") }}</div>
                </div>

                <div class="d-flex gap-2">
                    <button
                        class="btn btn-outline-primary btn-sm"
                        type="button"
                        :disabled="testing === index"
                        @click="test(index)"
                    >
                        {{ $t("registryTest") }}
                    </button>
                    <button class="btn btn-outline-danger btn-sm" type="button" @click="remove(index)">
                        {{ $t("registryRemove") }}
                    </button>
                </div>

                <div v-if="credential.result" class="form-text" :class="credential.result.ok ? 'text-success' : 'text-danger'">
                    {{ credential.result.msg }}
                </div>
            </div>

            <div class="d-flex gap-2">
                <button class="btn btn-outline-primary" type="button" @click="add">
                    {{ $t("registryAdd") }}
                </button>
                <button class="btn btn-primary" type="submit" :disabled="saving">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },

    data() {
        return {
            /**
             * The logins being edited. `stored` marks an entry the server
             * already has a password for, so an empty password field means
             * "keep it" rather than "no password".
             */
            credentials: [],
            rateLimit: null,
            rateLimitError: null,
            rateLimitLoading: false,
            saving: false,
            testing: null,
        };
    },

    computed: {
        /** The rate limit window, in whole hours when it divides evenly */
        rateLimitWindow() {
            const seconds = this.rateLimit?.windowSeconds;

            if (!seconds) {
                return this.$t("registryRateLimitWindowUnknown");
            }

            const hours = seconds / 3600;
            return Number.isInteger(hours) ? `${hours}h` : `${Math.round(seconds / 60)}m`;
        },
    },

    mounted() {
        this.load();
        this.loadRateLimit();
    },

    methods: {
        /** Load the stored logins (without their secrets) */
        load() {
            this.$root.getSocket().emit("getRegistryCredentials", (res) => {
                if (!res.ok) {
                    this.$root.toastRes(res);
                    return;
                }

                this.credentials = res.data.map((credential) => {
                    return {
                        registry: credential.registry,
                        username: credential.username,
                        password: "",
                        stored: true,
                        result: null,
                    };
                });
            });
        },

        /** Ask the server what Docker Hub currently allows */
        loadRateLimit() {
            this.rateLimitLoading = true;
            this.rateLimitError = null;

            this.$root.getSocket().emit("getDockerHubRateLimit", (res) => {
                this.rateLimitLoading = false;

                if (res.ok) {
                    this.rateLimit = res.rateLimit;
                } else {
                    this.rateLimit = null;
                    this.rateLimitError = res.msg;
                }
            });
        },

        /** Add an empty row, pre-filled with Docker Hub when it is not there yet */
        add() {
            const hasDockerHub = this.credentials.some((credential) => credential.registry === "docker.io");

            this.credentials.push({
                registry: hasDockerHub ? "" : "docker.io",
                username: "",
                password: "",
                stored: false,
                result: null,
            });
        },

        /**
         * Drop a row. It is only gone from the server once saved.
         * @param {number} index Row to remove
         */
        remove(index) {
            this.credentials.splice(index, 1);
        },

        /**
         * Check one login against its registry
         * @param {number} index Row to check
         */
        test(index) {
            const credential = this.credentials[index];
            this.testing = index;
            credential.result = null;

            this.$root.getSocket().emit("testRegistryCredential", credential.registry, credential.username, credential.password, (res) => {
                this.testing = null;
                credential.result = {
                    ok: res.ok,
                    msg: res.msg,
                };

                if (res.ok && res.rateLimit && credential.registry === "docker.io") {
                    this.rateLimit = res.rateLimit;
                }
            });
        },

        /** Store the logins and refresh what Docker Hub reports afterwards */
        save() {
            this.saving = true;

            const payload = this.credentials.map((credential) => {
                return {
                    registry: credential.registry,
                    username: credential.username,
                    password: credential.password,
                };
            });

            this.$root.getSocket().emit("saveRegistryCredentials", payload, (res) => {
                this.saving = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.load();
                    this.loadRateLimit();
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../styles/vars.scss";

.rate-limit,
.credential {
    padding: 15px;
    border-radius: 10px;
    border: 1px solid #dfe3e8;

    .dark & {
        border-color: $dark-border-color;
        background-color: $dark-bg2;
    }
}
</style>
