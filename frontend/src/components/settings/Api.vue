<template>
    <div class="my-4">
        <!-- eslint-disable-next-line vue/no-v-html -- renders a $t() translation, not user input -->
        <p class="form-text" v-html="$t('apiDescription')"></p>

        <div v-if="envKey" class="form-text mb-3">{{ $t("apiEnvKey") }}</div>

        <!-- A key that was just created, shown this once -->
        <div v-if="newKey" class="alert alert-success new-key">
            <div class="mb-2">{{ $t("apiKeyCreated", [ newKey.name ]) }}</div>
            <div class="input-group">
                <input ref="newKeyInput" class="form-control key" readonly :value="newKey.key" @focus="$event.target.select()" />
                <button class="btn btn-outline-primary" type="button" @click="copyNewKey">
                    <font-awesome-icon :icon="copied ? 'check' : 'copy'" />
                </button>
            </div>
            <div class="form-text">{{ $t("apiKeyShownOnce") }}</div>
        </div>

        <!-- Existing keys -->
        <div v-if="keys.length === 0" class="form-text mb-3">{{ $t("apiNoKeys") }}</div>

        <div v-else class="table-responsive mb-4">
            <table class="table mb-0">
                <thead>
                    <tr>
                        <th scope="col">{{ $t("apiKeyName") }}</th>
                        <th scope="col">{{ $t("apiKeyAccess") }}</th>
                        <th scope="col">{{ $t("apiKeyLastUsed") }}</th>
                        <th scope="col"></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="key in keys" :key="key.id">
                        <td>
                            {{ key.name }}
                            <div class="form-text mt-0"><code>{{ key.prefix }}…</code> · {{ formatTime(key.createdAt) }}</div>
                        </td>
                        <td>
                            <span v-if="key.readOnly" class="badge bg-secondary">{{ $t("apiKeyReadOnly") }}</span>
                            <span v-else class="badge bg-primary">{{ $t("apiKeyFullAccess") }}</span>
                        </td>
                        <td>{{ key.lastUsedAt ? formatTime(key.lastUsedAt) : $t("apiKeyNeverUsed") }}</td>
                        <td class="text-end">
                            <button class="btn btn-outline-danger btn-sm" type="button" @click="confirmDelete(key)">
                                {{ $t("delete") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Create a key -->
        <form autocomplete="off" @submit.prevent="create">
            <h5 class="mb-3">{{ $t("apiCreateKey") }}</h5>

            <div class="mb-3">
                <label class="form-label" for="apiKeyName">{{ $t("apiKeyName") }}</label>
                <input id="apiKeyName" v-model="form.name" class="form-control" maxlength="64" required :placeholder="$t('apiKeyNamePlaceholder')" />
            </div>

            <div class="form-check form-switch mb-1">
                <input id="apiKeyReadOnly" v-model="form.readOnly" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="apiKeyReadOnly">{{ $t("apiKeyReadOnly") }}</label>
            </div>
            <div class="form-text mb-3">{{ $t("apiKeyReadOnlyHint") }}</div>

            <div v-if="!settings.disableAuth" class="mb-3">
                <label class="form-label" for="apiKeyPassword">{{ $t("Current Password") }}</label>
                <input id="apiKeyPassword" v-model="form.currentPassword" type="password" class="form-control" required autocomplete="current-password" />
                <div class="form-text">{{ $t("apiKeyPasswordHint") }}</div>
            </div>

            <button class="btn btn-primary" type="submit" :disabled="creating">
                <font-awesome-icon icon="key" class="me-1" />
                {{ $t("apiCreateKey") }}
            </button>
        </form>

        <!-- How to use it -->
        <div class="mt-4">
            <h5>{{ $t("apiUsage") }}</h5>
            <pre class="usage mb-1">curl -H "X-API-Key: {{ newKey ? newKey.key : "&lt;key&gt;" }}" {{ apiURL }}stacks</pre>
            <!-- eslint-disable-next-line vue/no-v-html -- renders a $t() translation, not user input -->
            <div class="form-text" v-html="$t('apiUsageHint')"></div>
        </div>

        <Confirm ref="confirmDelete" btn-style="btn-danger" :yes-text="$t('delete')" :no-text="$t('cancel')" @yes="deleteKey">
            {{ $t("apiKeyDeleteConfirm", [ deleting?.name ?? "" ]) }}
        </Confirm>
    </div>
</template>

<script>
import dayjs from "dayjs";
import Confirm from "../Confirm.vue";

export default {
    components: {
        Confirm,
    },

    data() {
        return {
            keys: [],
            envKey: false,
            creating: false,
            form: {
                name: "",
                readOnly: false,
                currentPassword: "",
            },

            /** The key just created: the only time it can be shown */
            newKey: null,
            copied: false,
            deleting: null,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },

        /** Where the API is, as this browser reaches Dockge */
        apiURL() {
            return new URL("api/", document.baseURI).href;
        },
    },

    mounted() {
        this.load();
    },

    methods: {
        load() {
            this.$root.getSocket().emit("getApiKeys", (res) => {
                if (res.ok) {
                    this.keys = res.keys;
                    this.envKey = res.envKey;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        create() {
            this.creating = true;
            this.$root.getSocket().emit("createApiKey", this.form.name, this.form.readOnly, this.form.currentPassword, (res) => {
                this.creating = false;

                if (res.ok) {
                    this.newKey = {
                        name: res.info.name,
                        key: res.key,
                    };
                    this.copied = false;
                    this.form = {
                        name: "",
                        readOnly: false,
                        currentPassword: "",
                    };
                    this.load();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Copy the new key. navigator.clipboard only exists over HTTPS, so
         * over plain HTTP the field is selected and copied the old way.
         */
        async copyNewKey() {
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(this.newKey.key);
                } else {
                    this.$refs.newKeyInput.select();
                    document.execCommand("copy");
                }
                this.copied = true;
            } catch (e) {
                this.$refs.newKeyInput.select();
            }
        },

        confirmDelete(key) {
            this.deleting = key;
            this.$refs.confirmDelete.show();
        },

        deleteKey() {
            const key = this.deleting;
            this.$root.getSocket().emit("deleteApiKey", key.id, (res) => {
                this.$root.toastRes(res);
                this.load();
            });
        },

        formatTime(time) {
            return dayjs(time).format("YYYY-MM-DD HH:mm");
        },
    },
};
</script>

<style lang="scss" scoped>
.key, .usage {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
}

.usage {
    white-space: pre-wrap;
    word-break: break-all;
}
</style>
