<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-3">{{ $t("updateHistory") }}</h1>

            <div class="shadow-box big-padding">
                <!-- Filters -->
                <div class="row g-2 mb-3">
                    <div v-if="multipleAgents" class="col-md-3">
                        <select v-model="filterEndpoint" class="form-select" :aria-label="$tc('dockgeAgent', 1)">
                            <option :value="ALL_ENDPOINTS">{{ $t("allAgents") }}</option>
                            <option v-for="endpoint in endpoints" :key="endpoint" :value="endpoint">{{ $root.getAgentName(endpoint) }}</option>
                        </select>
                    </div>
                    <div class="col-md">
                        <input v-model="filterSearch" type="search" class="form-control" :placeholder="$t('updateHistorySearch')" />
                    </div>
                    <div class="col-md-3">
                        <select v-model="filterTrigger" class="form-select" :aria-label="$t('updateHistoryTrigger')">
                            <option value="">{{ $t("updateHistoryAnyTrigger") }}</option>
                            <option v-for="trigger in UPDATE_TRIGGERS" :key="trigger" :value="trigger">{{ $t("updateTrigger_" + trigger) }}</option>
                        </select>
                    </div>
                    <div class="col-md-3">
                        <select v-model="filterResult" class="form-select" :aria-label="$t('updateHistoryResult')">
                            <option value="">{{ $t("updateHistoryAnyResult") }}</option>
                            <option value="true">{{ $t("updateSucceeded") }}</option>
                            <option value="false">{{ $t("updateFailed") }}</option>
                        </select>
                    </div>
                </div>

                <div v-if="unreachable.length > 0" class="alert alert-warning py-2">
                    {{ $t("updateHistoryUnreachable", [ unreachable.map((e) => $root.getAgentName(e)).join(", ") ]) }}
                </div>

                <div v-if="loading && entries.length === 0">{{ $t("fetchingData") }}</div>

                <div v-else-if="entries.length === 0" class="text-muted">
                    {{ $t("updateHistoryEmpty") }}
                </div>

                <div v-else class="table-responsive">
                    <table class="table table-hover mb-0">
                        <thead>
                            <tr>
                                <th scope="col">{{ $t("updateHistoryStarted") }}</th>
                                <th v-if="multipleAgents" scope="col">{{ $tc("dockgeAgent", 1) }}</th>
                                <th scope="col">{{ $tc("stack", 1) }}</th>
                                <th scope="col">{{ $t("updateHistoryTrigger") }}</th>
                                <th scope="col">{{ $t("updateHistoryResult") }}</th>
                                <th scope="col" class="text-end">{{ $t("updateHistoryDuration") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <template v-for="entry in entries" :key="entryKey(entry)">
                                <tr class="entry" :class="{ open: openKey === entryKey(entry) }" @click="toggle(entry)">
                                    <td :title="entry.startedAt">{{ formatTime(entry.startedAt) }}</td>
                                    <td v-if="multipleAgents">{{ $root.getAgentName(entry.endpoint) }}</td>
                                    <td>
                                        {{ entry.stackName }}
                                        <span v-if="entry.serviceName" class="text-muted">/ {{ entry.serviceName }}</span>
                                    </td>
                                    <td>{{ triggerLabel(entry.triggerType) }}</td>
                                    <td>
                                        <span v-if="entry.success" class="badge bg-primary">{{ $t("updateSucceeded") }}</span>
                                        <span v-else class="badge bg-danger" :title="entry.errorMessage ?? ''">{{ $t("updateFailed") }}</span>
                                    </td>
                                    <td class="text-end">{{ formatDuration(entry.durationMs) }}</td>
                                </tr>
                                <tr v-if="openKey === entryKey(entry)" class="output-row">
                                    <td :colspan="multipleAgents ? 6 : 5">
                                        <div v-if="!entry.success && entry.errorMessage" class="text-danger mb-2">{{ entry.errorMessage }}</div>
                                        <div v-if="outputLoading">{{ $t("fetchingData") }}</div>
                                        <pre v-else class="output mb-0">{{ output || $t("updateHistoryNoOutput") }}</pre>
                                    </td>
                                </tr>
                            </template>
                        </tbody>
                    </table>
                </div>

                <!-- Paging -->
                <div v-if="total > pageSize" class="d-flex align-items-center justify-content-end gap-2 mt-3">
                    <span class="text-muted me-2">{{ $t("updateHistoryRange", [ offset + 1, Math.min(offset + pageSize, total), total ]) }}</span>
                    <button class="btn btn-normal btn-sm" :disabled="offset === 0 || loading" @click="offset = Math.max(0, offset - pageSize)">
                        <font-awesome-icon icon="chevron-right" class="flip" />
                    </button>
                    <button class="btn btn-normal btn-sm" :disabled="offset + pageSize >= total || loading" @click="offset += pageSize">
                        <font-awesome-icon icon="chevron-right" />
                    </button>
                </div>
            </div>
        </div>
    </transition>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import dayjs from "dayjs";
import { ALL_ENDPOINTS } from "../../../common/util-common";
import { UPDATE_TRIGGERS, UpdateHistoryEntry } from "../../../common/types";

export default defineComponent({
    data() {
        return {
            ALL_ENDPOINTS,
            UPDATE_TRIGGERS,
            entries: [] as UpdateHistoryEntry[],
            total: 0,
            unreachable: [] as string[],
            loading: false,
            offset: 0,
            pageSize: 25,
            filterEndpoint: ALL_ENDPOINTS,
            filterSearch: "",
            filterTrigger: "",
            filterResult: "",
            searchTimer: undefined as ReturnType<typeof setTimeout> | undefined,

            // Only the latest request is shown, so a slow answer to an older
            // filter cannot overwrite a newer one
            requestID: 0,

            openKey: "",
            output: "",
            outputLoading: false,
        };
    },

    computed: {
        endpoints() : string[] {
            return Object.keys(this.$root.agentList);
        },

        multipleAgents() : boolean {
            return this.endpoints.length > 1;
        },
    },

    watch: {
        offset() {
            this.load();
        },
        filterEndpoint() {
            this.reload();
        },
        filterTrigger() {
            this.reload();
        },
        filterResult() {
            this.reload();
        },
        filterSearch() {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.reload(), 300);
        },

        // The agent list arrives after login, possibly after the first page
        // was already asked for without them
        endpoints(to : string[], from : string[]) {
            if (to.join() !== from.join()) {
                this.reload();
            }
        },
    },

    mounted() {
        this.load();
    },

    beforeUnmount() {
        clearTimeout(this.searchTimer);
    },

    methods: {
        /**
         * Back to the first page, which loads it
         */
        reload() {
            if (this.offset === 0) {
                this.load();
            } else {
                this.offset = 0;
            }
        },

        load() {
            const requestID = ++this.requestID;
            this.loading = true;

            const filter : Record<string, unknown> = {
                limit: this.pageSize,
                offset: this.offset,
            };
            if (this.filterSearch.trim()) {
                filter.search = this.filterSearch.trim();
            }
            if (this.filterTrigger) {
                filter.triggerType = this.filterTrigger;
            }
            if (this.filterResult) {
                filter.success = this.filterResult === "true";
            }

            this.$root.getSocket().emit("getUpdateHistory", this.filterEndpoint, filter, (res) => {
                if (requestID !== this.requestID) {
                    return;
                }
                this.loading = false;

                if (res.ok) {
                    this.entries = res.entries;
                    this.total = res.total;
                    this.unreachable = res.unreachable ?? [];
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        entryKey(entry : UpdateHistoryEntry) : string {
            return `${entry.endpoint}|${entry.id}`;
        },

        /**
         * Show or hide an entry's output, which is only fetched when it is
         * opened
         * @param entry The entry
         */
        toggle(entry : UpdateHistoryEntry) {
            const key = this.entryKey(entry);

            if (this.openKey === key) {
                this.openKey = "";
                return;
            }

            this.openKey = key;
            this.output = "";
            this.outputLoading = true;

            this.$root.emitAgent(entry.endpoint, "getUpdateHistoryEntry", entry.id, (res) => {
                if (this.openKey !== key) {
                    return;
                }
                this.outputLoading = false;

                if (res.ok) {
                    this.output = res.entry.output ?? "";
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * @param trigger What started an update
         * @returns How to show it. A database carried over from finder39/dockge
         * can hold kinds this one does not have; those are shown as they are.
         */
        triggerLabel(trigger : string) : string {
            return (UPDATE_TRIGGERS as string[]).includes(trigger) ? this.$t("updateTrigger_" + trigger) : trigger;
        },

        formatTime(time : string) : string {
            return dayjs(time).format("YYYY-MM-DD HH:mm:ss");
        },

        formatDuration(ms : number | null) : string {
            if (ms === null || ms === undefined) {
                return "";
            }
            const seconds = Math.round(ms / 1000);
            if (seconds < 60) {
                return `${seconds}s`;
            }
            return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        },
    },
});
</script>

<style lang="scss" scoped>
.entry {
    cursor: pointer;
}

.output-row td {
    border-top: none;
}

.output {
    max-height: 400px;
    overflow: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-all;
}

.flip {
    transform: rotate(180deg);
}
</style>
