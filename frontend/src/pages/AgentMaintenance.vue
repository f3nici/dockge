<template>
    <transition name="slide-fade" appear>
        <div>
            <div>
                <h1 class="mb-3">{{ name }}</h1>
            </div>

            <button class="btn btn-primary mb-3" data-toggle="tooltip" :title="$t('tooltipOpenPruneDialog')" :disabled="processing" @click="showSystemPruneDialog = true">
                <font-awesome-icon icon="wrench" class="me-1" />
                <span>{{ $t("systemPrune") }}</span>
            </button>

            <!-- System prune form -->
            <BModal id="systemPrune" v-model="showSystemPruneDialog" :title="$t('systemPrune')" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('prune')" okVariant="danger" @ok="systemPrune" @show="resetSystemPrune" @hidden="resetSystemPrune">
                <p class="mb-3" v-html="$t('systemPruneMsg')"></p>

                <form @submit.prevent>
                    <div class="form-check form-switch">
                        <input
                            id="systemPruneAll"
                            v-model="systemPruneData.all"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="systemPruneAll">
                            {{ $t("systemPruneAll") }}
                        </label>
                    </div>

                    <div class="form-check form-switch mt-3">
                        <input
                            id="systemPruneVolumes"
                            v-model="systemPruneData.volumes"
                            class="form-check-input"
                            type="checkbox"
                        />
                        <label class="form-check-label" for="systemPruneVolumes">
                            {{ $t("systemPruneVolumes") }}
                        </label>
                    </div>
                </form>
            </BModal>

            <ProgressTerminal ref="progressTerminal" :name="terminalName" :endpoint="endpoint" />

            <div class="shadow-box mt-3">
                <b-tabs v-model="activeArtefactIndex" nav-item-class="artefact-tab me-2" active-nav-item-class="active-artefact-tab" pills>
                    <template v-for="(info, index) in Object.values(DockerArtefactInfos)" :key="info.name">
                        <b-tab active lazy :title="$tc(info.name, 2)">
                            <div class="mt-4">
                                <DockerArtefact :ref="info.name" :endpoint="endpoint" :artefact="info" />
                            </div>
                        </b-tab>
                    </template>
                </b-tabs>
            </div>
        </div>
    </transition>
</template>

<script lang="ts">
import { defineComponent, getCurrentInstance, ref, reactive, computed, onMounted, provide } from "vue";
import { useRoute } from "vue-router";
import { getAgentMaintenanceTerminalName } from "../../../common/util-common";
import { DockerArtefactInfos } from "../../../common/types";
import DockerArtefact from "../components/DockerArtefact.vue";
import ProgressTerminal from "../components/ProgressTerminal.vue";

export default defineComponent({
    components: {
        DockerArtefact,
        ProgressTerminal
    },

    setup() {
        const route = useRoute();

        const proxy = getCurrentInstance()?.proxy;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const root = proxy?.$root as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refs = proxy?.$refs as any;

        // State
        const processing = ref(false);
        const showSystemPruneDialog = ref(false);
        const activeArtefactIndex = ref(0);
        const systemPruneData = reactive({
            all: false,
            volumes: false
        });

        const progressTerminal = ref<InstanceType<typeof ProgressTerminal>>();

        // Computed
        const endpoint = computed(() => route.params.endpoint as string || "");
        const name = computed(() => root?.getAgentName(endpoint.value));
        const terminalName = computed(() => getAgentMaintenanceTerminalName(endpoint.value));

        // Methods
        function resetSystemPrune() {
            systemPruneData.all = false;
            systemPruneData.volumes = false;
        }

        function systemPrune() {
            startAction();

            root.emitAgent(endpoint.value, "dockerSystemPrune", systemPruneData.all, systemPruneData.volumes, (res) => {
                stopAction();
                root.toastRes(res);
                reloadArtefactsData();
            });
        }

        function startAction() {
            processing.value = true;
            progressTerminal.value?.show();
        }

        function stopAction() {
            processing.value = false;
            progressTerminal.value?.hideWithTimeout();
        }

        function reloadArtefactsData() {
            for (const artefact of Object.values(DockerArtefactInfos)) {
                const ref = refs[artefact.name];

                // Check if array
                const componentInstances = Array.isArray(ref) ? ref : [ ref ];

                for (const comp of componentInstances) {
                    if (comp && typeof comp.loadData === "function") {
                        console.debug("Reload " + artefact.name);
                        comp.loadData();
                    }
                }
            }
        }

        onMounted(() => {
        });

        // Provide
        provide("processing", processing);
        provide("startAction", startAction);
        provide("stopAction", stopAction);

        return {
            DockerArtefactInfos,
            processing,
            showSystemPruneDialog,
            activeArtefactIndex,
            systemPruneData,
            endpoint,
            name,
            terminalName,
            progressTerminal,
            resetSystemPrune,
            systemPrune,
            startPruneAction: startAction,
            stopPruneAction: stopAction,
            reloadArtefactsData
        };
    }
});
</script>

<style scoped lang="scss">
@import "../styles/vars.scss";

:deep(.artefact-tab:hover) {
    background: $dark-header-active-bg;
}

:deep(.active-artefact-tab) {
    background: $dark-header-active-bg !important;
    color: $dark-font-color !important;
    border-bottom: 4px solid $primary;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
}

</style>
