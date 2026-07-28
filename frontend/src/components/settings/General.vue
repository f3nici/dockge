<template>
    <div>
        <form class="my-4" autocomplete="off" @submit.prevent="saveGeneral">
            <!-- Client side Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Display Timezone") }}
                </label>
                <select id="timezone" v-model="$root.userTimezone" class="form-select">
                    <option value="auto">
                        {{ $t("Auto") }}: {{ guessTimezone }}
                    </option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Server Timezone -->
            <div v-if="false" class="mb-4">
                <label for="timezone" class="form-label">
                    {{ $t("Server Timezone") }}
                </label>
                <select id="timezone" v-model="settings.serverTimezone" class="form-select">
                    <option value="UTC">UTC</option>
                    <option
                        v-for="(timezone, index) in timezoneList"
                        :key="index"
                        :value="timezone.value"
                    >
                        {{ timezone.name }}
                    </option>
                </select>
            </div>

            <!-- Primary Hostname -->
            <div class="mb-4">
                <label class="form-label" for="primaryBaseURL">
                    {{ $t("primaryHostname") }}
                </label>

                <div class="input-group mb-3">
                    <input
                        v-model="settings.primaryHostname"
                        class="form-control"
                        :placeholder="$t(`CurrentHostname`)"
                    />
                    <button class="btn btn-outline-primary" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <div class="form-text"></div>
            </div>

            <!-- Auto Update -->
            <div class="mb-4">
                <label class="form-label">{{ $t("autoUpdate") }}</label>

                <div class="form-check form-switch">
                    <input
                        id="autoUpdateEnabled"
                        v-model="settings.autoUpdateEnabled"
                        class="form-check-input"
                        type="checkbox"
                    />
                    <label class="form-check-label" for="autoUpdateEnabled">
                        {{ $t("autoUpdateEnabled") }}
                    </label>
                </div>
                <div class="form-text">{{ $t("autoUpdateDescription") }}</div>

                <template v-if="settings.autoUpdateEnabled">
                    <!-- Schedule -->
                    <div class="mt-3">
                        <label class="form-label" for="autoUpdateCron">
                            {{ $t("autoUpdateSchedule") }}
                        </label>
                        <select v-model="autoUpdatePreset" class="form-select mb-2">
                            <option value="0 4 * * 0">{{ $t("autoUpdateWeekly") }}</option>
                            <option value="0 4 * * *">{{ $t("autoUpdateDaily") }}</option>
                            <option value="0 4 1 * *">{{ $t("autoUpdateMonthly") }}</option>
                            <option value="custom">{{ $t("autoUpdateCustom") }}</option>
                        </select>
                        <input
                            id="autoUpdateCron"
                            v-model="settings.autoUpdateCron"
                            class="form-control"
                            :readonly="autoUpdatePreset !== 'custom'"
                            placeholder="0 4 * * 0"
                        />
                        <div class="form-text" v-html="$t('autoUpdateCronHint')"></div>
                    </div>

                    <!-- Prune -->
                    <div class="form-check form-switch mt-3">
                        <input
                            id="autoUpdatePrune"
                            v-model="settings.autoUpdatePrune"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="autoUpdatePrune">
                            {{ $t("autoUpdatePrune") }}
                        </label>
                    </div>
                </template>

                <!-- Update now -->
                <div class="mt-3">
                    <button class="btn btn-normal" type="button" :disabled="autoUpdating" @click="triggerAutoUpdate">
                        <font-awesome-icon v-if="autoUpdating" icon="spinner" spin class="me-1" />
                        <font-awesome-icon v-else icon="cloud-arrow-down" class="me-1" />
                        {{ $t("autoUpdateNow") }}
                    </button>
                    <div class="form-text">{{ $t("autoUpdateNowHint") }}</div>
                </div>
            </div>

            <!-- Save Button -->
            <div>
                <button class="btn btn-primary" type="submit">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>
    </div>
</template>

<script>

import dayjs from "dayjs";
import { timezoneList } from "../../util-frontend";

export default {
    components: {

    },

    data() {
        return {
            timezoneList: timezoneList(),
            autoUpdating: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        /**
         * Maps the stored cron expression to one of the preset options, or
         * "custom" when it does not match a known preset.
         */
        autoUpdatePreset: {
            get() {
                const presets = [ "0 4 * * 0", "0 4 * * *", "0 4 1 * *" ];
                if (presets.includes(this.settings.autoUpdateCron)) {
                    return this.settings.autoUpdateCron;
                }
                return "custom";
            },
            set(value) {
                if (value !== "custom") {
                    this.settings.autoUpdateCron = value;
                }
            },
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        guessTimezone() {
            return dayjs.tz.guess();
        }
    },

    watch: {
        "settings.autoUpdateEnabled"(enabled) {
            // Seed a sensible default schedule the first time auto update is switched on
            if (enabled && !this.settings.autoUpdateCron) {
                this.settings.autoUpdateCron = "0 4 * * 0";
            }
        },
    },

    methods: {
        /** Save the settings */
        saveGeneral() {
            localStorage.timezone = this.$root.userTimezone;
            this.saveSettings();
        },
        /** Get the base URL of the application */
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },
        /** Trigger an auto update run immediately */
        triggerAutoUpdate() {
            this.autoUpdating = true;
            this.$root.getSocket().emit("triggerAutoUpdate", (res) => {
                this.autoUpdating = false;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>

