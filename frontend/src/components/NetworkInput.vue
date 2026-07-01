<template>
    <div>
        <h5>{{ $t("Internal Networks") }}</h5>
        <ul class="list-group">
            <li v-for="(networkRow, index) in networkList as {name: string, data: any}[]" :key="index" class="list-group-item flex-column align-items-stretch">
                <div class="d-flex align-items-center w-100">
                    <input v-model="networkRow.name" type="text" class="no-bg domain-input" :placeholder="$t(`Network name...`)" />
                    <font-awesome-icon icon="times" class="action remove ms-2 me-3 text-danger" @click="remove(index)" />
                </div>

                <div class="network-options mt-2">
                    <div class="d-flex align-items-center flex-wrap gap-3">
                        <div class="d-flex align-items-center">
                            <label :for="'network-driver-' + index" class="form-label mb-0 me-2 network-option-label">{{ $t("networkDriver") }}</label>
                            <select :id="'network-driver-' + index" v-model="networkRow.data.driver" class="form-select form-select-sm driver-select">
                                <option v-for="driver in driverOptions" :key="driver" :value="driver">{{ driver }}</option>
                            </select>
                        </div>

                        <div class="form-check form-switch mb-0">
                            <input
                                :id="'network-ipv6-' + index"
                                class="form-check-input"
                                type="checkbox"
                                :checked="isIPv6Enabled(networkRow)"
                                @change="setIPv6Enabled(networkRow, ($event.target as HTMLInputElement).checked)"
                            >
                            <label class="form-check-label network-option-label" :for="'network-ipv6-' + index">
                                {{ $t("enableIPv6") }}
                            </label>
                        </div>
                    </div>

                    <button class="btn btn-normal btn-sm mt-2" :disabled="!networkRow.name" @click="addAllContainers(networkRow.name)">
                        <font-awesome-icon icon="plus" class="me-1" />{{ $t("addAllContainersToNetwork") }}
                    </button>
                </div>
            </li>
        </ul>

        <button class="btn btn-normal btn-sm mt-3 me-2" @click="addField">{{ $t("addInternalNetwork") }}</button>

        <h5 class="mt-3">{{ $t("External Networks") }}</h5>

        <div v-if="externalNetworkList.length === 0">
            {{ $t("No External Networks") }}
        </div>

        <div v-for="(networkName, index) in externalNetworkList" :key="networkName" class="form-check form-switch my-3">
            <input :id=" 'external-network' + index" v-model="selectedExternalList[networkName]" class="form-check-input" type="checkbox">

            <label class="form-check-label" :for=" 'external-network' +index">
                {{ networkName }}
            </label>

            <span v-if="false" class="text-danger ms-2 delete">Delete</span>
        </div>

        <!--div v-if="false" class="input-group mb-3">
            <input
                placeholder="New external network name..."
                class="form-control"
                @keyup.enter="createExternelNetwork"
            />
            <button class="btn btn-normal btn-sm  me-2" type="button">
                {{ $t("createExternalNetwork") }}
            </button>
        </div>

        <div v-if="false">
            <button class="btn btn-primary btn-sm mt-3 me-2" @click="applyToComposeDocument">{{ $t("applyToYAML") }}</button>
        </div-->
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { ComposeDocument, ComposeNetwork } from "../../../common/compose-document";
import { StackData } from "../../../common/types";

type NetworkRow = {
    name: string;
    data: Record<string, unknown>;
};

export default defineComponent({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data() {
        return {
            networkList: [],
            externalList: {},
            selectedExternalList: {},
            externalNetworkList: [],
            // Empty option lets docker-compose use its default (bridge) without writing a driver key
            driverOptions: [ "", "bridge", "host", "overlay", "ipvlan", "macvlan", "none" ],
        };
    },
    computed: {
        composeDocument(): ComposeDocument {
            return this.$parent.$parent.composeDocument;
        },

        stack(): StackData {
            return this.$parent.$parent.stack;
        },

        editorFocus() {
            return this.$parent.$parent.editorFocus;
        },

        endpoint() {
            return this.$parent.$parent.endpoint;
        },
    },
    watch: {
        "composeDocument.networks.composeData.data": {
            handler() {
                if (this.editorFocus) {
                    console.debug("jsonConfig.networks changed");
                    this.loadNetworkList();
                }
            },
            deep: true,
        },

        selectedExternalList: {
            handler() {
                for (const networkName in this.selectedExternalList) {
                    const enable = this.selectedExternalList[networkName];

                    if (enable) {
                        if (!this.externalList[networkName]) {
                            this.externalList[networkName] = {};
                        }
                        this.externalList[networkName].external = true;
                    } else {
                        delete this.externalList[networkName];
                    }
                }
                this.applyToComposeDocument();
            },
            deep: true,
        },

        networkList: {
            handler() {
                this.applyToComposeDocument();
            },
            deep: true,
        }

    },
    mounted() {
        this.loadNetworkList();
        this.loadExternalNetworkList();
    },
    methods: {
        loadNetworkList() {
            this.networkList = [];
            this.externalList = {};

            for (const [ name, network ] of Object.entries(this.composeDocument.networks.getNetworks()) as [string, ComposeNetwork][]) {
                const networkObj = {
                    name: name,
                    data: network.composeData.data,
                };

                if (network.external) {
                    this.externalList[name] = Object.assign({}, networkObj.data);
                } else {
                    this.networkList.push(networkObj);
                }
            }

            // Restore selectedExternalList
            this.selectedExternalList = {};
            for (const networkName in this.externalList) {
                this.selectedExternalList[networkName] = true;
            }
        },

        loadExternalNetworkList() {
            this.$root.emitAgent(this.endpoint, "getDockerNetworkList", (res) => {
                if (res.ok) {
                    this.externalNetworkList = res.dockerNetworkList.filter((n) => {
                        // Filter out this stack networks
                        if (n.startsWith(this.stack.name + "_")) {
                            return false;
                        }
                        // They should be not supported.
                        // https://docs.docker.com/compose/compose-file/06-networks/#host-or-none
                        if (n === "none" || n === "host" || n === "bridge") {
                            return false;
                        }
                        return true;
                    });
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        addField() {
            this.networkList.push({
                name: "",
                data: {
                    driver: "bridge",
                },
            });
        },

        remove(index: number) {
            this.networkList.splice(index, 1);
            this.applyToComposeDocument();
        },

        isIPv6Enabled(networkRow: NetworkRow): boolean {
            // Only false when explicitly disabled, otherwise fall back to the docker default (enabled)
            return networkRow.data.enable_ipv6 !== false;
        },

        setIPv6Enabled(networkRow: NetworkRow, enabled: boolean) {
            if (enabled) {
                // Remove the key so we don't clutter the compose file with the default value
                delete networkRow.data.enable_ipv6;
            } else {
                networkRow.data.enable_ipv6 = false;
            }
            this.applyToComposeDocument();
        },

        addAllContainers(networkName: string) {
            if (!networkName) {
                this.$root.toastError(this.$t("networkNameRequired"));
                return;
            }

            // Make sure the network itself is defined before referencing it from services
            this.applyToComposeDocument();

            const services = this.composeDocument.services;
            let addedCount = 0;

            for (const serviceName of services.names) {
                const serviceNetworks = services.getService(serviceName).networks;
                if (!serviceNetworks.values.includes(networkName)) {
                    serviceNetworks.add(networkName);
                    addedCount++;
                }
            }

            this.$root.toastSuccess(this.$t("addedContainersToNetwork", {
                count: addedCount,
                network: networkName
            }));
        },

        applyToComposeDocument() {
            if (this.editorFocus) {
                return;
            }

            const networks = {};

            // Internal networks
            for (const networkRow of this.networkList) {
                const data = Object.assign({}, networkRow.data);

                // Drop an empty driver so docker-compose falls back to its default
                if (!data.driver) {
                    delete data.driver;
                }

                networks[networkRow.name] = data;
            }

            // External networks
            for (const networkName in this.externalList) {
                networks[networkName] = this.externalList[networkName];
            }

            this.composeDocument.networks.replace(networks);

            console.debug("applyToComposeDocument", networks);
        }

    },
});
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.list-group {
    background-color: $dark-bg2;

    li {
        display: flex;
        align-items: center;
        padding: 10px 0 10px 10px;

        .domain-input {
            flex-grow: 1;
            background-color: $dark-bg2;
            border: none;
            color: $dark-font-color;
            outline: none;
        }
    }
}

.delete {
    text-decoration: underline;
    font-size: 13px;
    cursor: pointer;
}

.network-options {
    .network-option-label {
        font-size: 13px;
        color: $dark-font-color;
    }

    .driver-select {
        width: auto;
        min-width: 110px;
        background-color: $dark-bg2;
        color: $dark-font-color;
        border-color: $dark-border-color;
    }
}
</style>
