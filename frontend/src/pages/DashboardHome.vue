stackStatusList<template>
    <transition ref="tableContainer" name="slide-fade" appear>
        <div v-if="$route.name === 'DashboardHome'">
            <h1 class="mb-3">
                {{ $t("home") }}
            </h1>

            <div class="row first-row">
                <!-- Left -->
                <div class="col-lg-7">
                    <!-- Stats -->
                    <div class="shadow-box big-padding text-center mb-5">
                        <div class="row">
                            <template v-for="(info, index) in statusInfos" :key="index">
                                <div v-if="getStatusCount(info.statusIds) > 0" class="col">
                                    <h3>{{ $t(info.label) }}</h3>
                                    <span class="num num-lg" :style="getInfoStyle(info)" @click="filterStackList(undefined, info)">{{ getStatusCount(info.statusIds) }}</span>
                                </div>
                            </template>
                        </div>
                    </div>

                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <h4>{{ $tc("dockgeAgent", 2) }}</h4>
                        <button v-if="!showAgentForm" class="btn btn-primary" @click="showAgentForm = !showAgentForm">
                            <font-awesome-icon icon="plus" /> {{ $t("addAgent") }}
                        </button>
                    </div>

                    <!-- Agent list -->
                    <div v-for="(agent, endpoint) in agentList" :key="endpoint" class="mb-3 agent">
                        <div class="shadow-box big-padding">
                            <div class="d-flex justify-content-between align-items-center">
                                <div class="d-flex align-items-baseline">
                                    <h4 class="me-2">{{ getAgentName(agent) }}</h4>

                                    <!-- Edit Name  -->
                                    <font-awesome-icon class="ms-3 action-icon" icon="pen-to-square" @click="editAgentName(agent)" />

                                    <!-- Remove Button -->
                                    <font-awesome-icon v-if="endpoint !== ''" class="ms-3 action-icon" icon="trash" @click="showRemoveAgentDialog[agent.endpoint] = !showRemoveAgentDialog[agent.endpoint]" />
                                </div>

                                <router-link v-if="agentStatusList[endpoint] === 'online'" class="btn btn-sm btn-normal" data-toggle="tooltip" :title="$t('tooltipAgentMaintenance')" :to="getAgentRouteLink(agent)">
                                    <font-awesome-icon icon="wrench" class="me-2" />{{ $t("maintenance") }}
                                </router-link>
                            </div>

                            <div class="mb-3">
                                <span class="url">{{ !!agent.url ? agent.url : "local" }}</span>
                            </div>

                            <div class="d-flex flex-wrap gap-3">
                                <!-- Agent Status -->
                                <template v-if="agentStatusList[endpoint]">
                                    <span v-if="agentStatusList[endpoint] === 'online'" class="badge bg-primary me-2">{{ $t("agentOnline") }}</span>
                                    <span v-else-if="agentStatusList[endpoint] === 'offline'" class="badge bg-danger me-2">{{ $t("agentOffline") }}</span>
                                    <span v-else class="badge bg-secondary me-2">{{ $t(agentStatusList[endpoint]) }}</span>
                                </template>
                                <template v-if="Object.keys(agentList).length > 1">
                                    <template v-for="(info, index) in statusInfos" :key="index">
                                        <template v-if="getEndpointStatusCount(endpoint, info.statusIds) > 0">
                                            <div>{{ $t(info.label) }}: <span class="num" :style="getInfoStyle(info)" @click="filterStackList(endpoint, info)">{{ getEndpointStatusCount(endpoint, info.statusIds) }}</span></div>
                                        </template>
                                    </template>
                                </template>
                            </div>

                            <!-- Edit Dialog -->
                            <BModal v-model="showEditAgentNameDialog[agent.endpoint]" :title="!!endpoint ? endpoint : 'Master'" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('Update Name')" okVariant="primary" @ok="updateAgentName(agent, editAgentNewName[agent.endpoint])">
                                <input :id="'nameUpdate' + agent.endpoint" v-model="editAgentNewName[agent.endpoint]" type="text" class="form-control">
                            </BModal>

                            <!-- Remove Agent Dialog -->
                            <BModal v-model="showRemoveAgentDialog[agent.endpoint]" :title="getAgentName(agent)" :okTitle="$t('removeAgent')" okVariant="danger" @ok="removeAgent(agent)">
                                {{ $t("removeAgentMsg") }}
                            </BModal>
                        </div>
                    </div>

                    <!-- Add Agent Form -->
                    <BModal id="addAgentDialog" v-model="showAgentForm" :title="$t('addAgent')" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="connectingAgent ? $t('connecting') : $t('connect')" okVariant="primary" @ok="addAgent" @show="resetNewAgent" @hidden="resetNewAgent">
                        <form @submit.prevent>
                            <div class="mb-3">
                                <label for="url" class="form-label">{{ $t("dockgeURL") }}</label>
                                <input id="url" v-model="newAgent.url" type="url" class="form-control" required placeholder="http://">
                            </div>

                            <div class="mb-3">
                                <label for="username" class="form-label">{{ $t("Username") }}</label>
                                <input id="username" v-model="newAgent.username" type="text" class="form-control" required>
                            </div>

                            <div class="mb-3">
                                <label for="password" class="form-label">{{ $t("Password") }}</label>
                                <input id="password" v-model="newAgent.password" type="password" class="form-control" required autocomplete="new-password">
                            </div>

                            <div class="mb-3">
                                <label for="name" class="form-label">{{ $t("Friendly Name") }}</label>
                                <input id="name" v-model="newAgent.name" type="text" class="form-control" optional>
                            </div>
                        </form>
                    </BModal>
                </div>

                <!-- Right -->
                <div class="col-lg-5">
                    <!-- Docker Run -->
                    <h2 class="mb-3">{{ $t("Docker Run") }}</h2>
                    <div class="mb-3">
                        <textarea id="name" v-model="dockerRunCommand" type="text" class="form-control docker-run" required placeholder="docker run ..."></textarea>
                    </div>

                    <button class="btn-normal btn mb-4" @click="convertDockerRun">{{ $t("Convert to Compose") }}</button>
                    <!-- Agent List -->
                </div>
            </div>
        </div>
    </transition>
    <router-view ref="child" />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { AgentData, SimpleStackData } from "../../../common/types";
import { StackFilter, StackStatusInfo } from "../../../common/util-common";

export default defineComponent({
    components: {

    },
    props: {
    },
    data(this: {newAgent: AgentData}) {
        return {
            page: 1,
            perPage: 25,
            initialPerPage: 25,
            paginationConfig: {
                hideCount: true,
                chunksNavigation: "scroll",
            },
            importantHeartBeatListLength: 0,
            displayedRecords: [],
            dockerRunCommand: "",
            showAgentForm: false,
            showRemoveAgentDialog: {},
            showEditAgentNameDialog: {},
            editAgentNewName: {},
            connectingAgent: false,
            newAgent: {}
        };
    },

    computed: {
        agentList(): Record<string, AgentData> {
            return this.$root.agentList;
        },
        agentStatusList(): Record<string, string> {
            return this.$root.agentStatusList;
        },
        stackList(): Record<string, SimpleStackData> {
            return this.$root.completeStackList;
        },
        statusInfos(): StackStatusInfo[] {
            return StackStatusInfo.ALL;
        },
        stackStatusCountByEndpoint(): Map<string, Map<number, number>> {
            const counts = new Map<string, Map<number, number>>();
            for (const stackData of Object.values(this.stackList) as SimpleStackData[]) {
                let endpointCounts = counts.get(stackData.endpoint);
                if (!endpointCounts) {
                    endpointCounts = new Map<number, number>();
                    counts.set(stackData.endpoint, endpointCounts);
                }

                endpointCounts.set(stackData.status, (endpointCounts.get(stackData.status) ?? 0) + 1);
            }

            return counts;
        },
        stackStatusCountOverall(): Map<number, number> {
            const counts = new Map<number, number>();

            for (const [ , innerMap ] of this.stackStatusCountByEndpoint) {
                for (const [ status, value ] of innerMap) {
                    counts.set(status, (counts.get(status) ?? 0) + value);
                }
            }

            return counts;
        },
    },

    watch: {
        perPage() {
            this.$nextTick(() => {
                this.getImportantHeartbeatListPaged();
            });
        },

        page() {
            this.getImportantHeartbeatListPaged();
        },
    },

    mounted() {
        this.initialPerPage = this.perPage;

        window.addEventListener("resize", this.updatePerPage);
        this.updatePerPage();

        this.resetNewAgent();
    },

    beforeUnmount() {
        window.removeEventListener("resize", this.updatePerPage);
    },

    methods: {

        getInfoStyle(info: StackStatusInfo) {
            return `color: var(--dockge-${info.textColor}-color);`;
        },

        getAgentName(agent) {
            return this.$root.getAgentName(agent.endpoint);
        },

        getAgentRouteLink(agent) {
            if (!!agent.endpoint) {
                return `/agent/${agent.endpoint}`;
            } else {
                return "/agent";
            }
        },

        getStatusCount(status: number[]): number {
            return status.reduce((acc, s) => acc + (this.stackStatusCountOverall.get(s) ?? 0), 0);
        },

        getEndpointStatusCount(endpoint: string, status: number[]): number {
            return status.reduce((acc, s) => acc + (this.stackStatusCountByEndpoint.get(endpoint)?.get(s) ?? 0), 0);
        },

        filterStackList(endpoint: string | undefined, statusInfo: StackStatusInfo) {
            const stackFilter = this.$root.stackFilter as StackFilter;
            stackFilter.clear();

            if (endpoint !== undefined) {
                stackFilter.agents.selected.add(endpoint);
            }

            stackFilter.status.selected.add(statusInfo.label);

            if (this.$root.isMobile) {
                this.$router.push("/stacks");
            }
        },

        resetNewAgent() {
            this.newAgent = {
                url: "http://",
                username: "",
                password: "",
                name: "",
            };
        },

        addAgent(bvModalEvt) {
            bvModalEvt.preventDefault();
            this.connectingAgent = true;
            this.$root.getSocket().emit("addAgent", this.newAgent, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                }

                this.connectingAgent = false;
            });
        },

        removeAgent(agent: AgentData) {
            this.$root.getSocket().emit("removeAgent", agent.url, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);

                    // Remove the stack list and status list of the removed agent
                    delete this.$root.allAgentStackList[agent.endpoint];
                }
            });
        },

        editAgentName(agent: AgentData) {
            this.editAgentNewName[agent.endpoint] = agent.name;
            this.showEditAgentNameDialog[agent.endpoint] = true;
        },

        updateAgentName(agent: AgentData, updatedName: string) {
            this.$root.getSocket().emit("updateAgent", agent.url, updatedName, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.agent = {
                        updatedName: "",
                    };
                }
            });
        },

        convertDockerRun() {
            if (this.dockerRunCommand.trim() === "docker run") {
                throw new Error("Please enter a docker run command");
            }

            // composerize is working in dev, but after "vite build", it is not working
            // So pass to backend to do the conversion
            this.$root.getSocket().emit("composerize", this.dockerRunCommand, (res) => {
                if (res.ok) {
                    this.$root.composeTemplate = res.composeTemplate;
                    this.$router.push("/compose");
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Updates the displayed records when a new important heartbeat arrives.
         * @param {object} heartbeat - The heartbeat object received.
         * @returns {void}
         */
        onNewImportantHeartbeat(heartbeat) {
            if (this.page === 1) {
                this.displayedRecords.unshift(heartbeat);
                if (this.displayedRecords.length > this.perPage) {
                    this.displayedRecords.pop();
                }
                this.importantHeartBeatListLength += 1;
            }
        },

        /**
         * Retrieves the length of the important heartbeat list for all monitors.
         * @returns {void}
         */
        getImportantHeartbeatListLength() {
            this.$root.getSocket().emit("monitorImportantHeartbeatListCount", null, (res) => {
                if (res.ok) {
                    this.importantHeartBeatListLength = res.count;
                    this.getImportantHeartbeatListPaged();
                }
            });
        },

        /**
         * Retrieves the important heartbeat list for the current page.
         * @returns {void}
         */
        getImportantHeartbeatListPaged() {
            const offset = (this.page - 1) * this.perPage;
            this.$root.getSocket().emit("monitorImportantHeartbeatListPaged", null, offset, this.perPage, (res) => {
                if (res.ok) {
                    this.displayedRecords = res.data;
                }
            });
        },

        /**
         * Updates the number of items shown per page based on the available height.
         * @returns {void}
         */
        updatePerPage() {
            const tableContainer = this.$refs.tableContainer;
            const tableContainerHeight = tableContainer.offsetHeight;
            const availableHeight = window.innerHeight - tableContainerHeight;
            const additionalPerPage = Math.floor(availableHeight / 58);

            if (additionalPerPage > 0) {
                this.perPage = Math.max(this.initialPerPage, this.perPage + additionalPerPage);
            } else {
                this.perPage = this.initialPerPage;
            }

        },
    }
});
</script>

<style lang="scss" scoped>
@import "../styles/vars";

.num-lg {
    font-size: 30px;
    display: block;
}

.num {
    cursor: pointer;
    font-weight: bold;
}

.url {
    font-size: 0.8rem;
    color: #6c757d;
}

.shadow-box {
    padding: 20px;
}

table {
    font-size: 14px;

    tr {
        transition: all ease-in-out 0.2ms;
    }

    @media (max-width: 550px) {
        table-layout: fixed;
        overflow-wrap: break-word;
    }
}

.docker-run {
    background-color: $dark-bg !important;
    border: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
}

.action-icon {
    cursor: pointer;
    color: rgba(255, 255, 255, 0.3);
}

.agent {
    a {
        text-decoration: none;
    }
}

</style>
