<template>
    <transition name="slide-fade" appear>
        <div>
            <div>
                <h1 class="mb-3">{{ name }}</h1>
            </div>

            <button class="btn btn-primary mb-3" data-toggle="tooltip" :title="$t('openSystemPruneDialog')" :disabled="processing" @click="showSystemPruneDialog = true">
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
                <b-tabs v-model="activeArtefactIndex" pills>
                    <template v-for="(artefact, index) in artefacts" :key="artefact">
                        <b-tab active lazy :title="$tc(artefact.name, 2)" :title-link-class="activeArtefactIndex === index ? 'active-artefact' : ''">
                            <div class="mt-4">
                                <DockerArtefact :ref="artefact.name" :endpoint="endpoint" :artefact="artefact.name" :hasPruneAll="artefact.hasPruneAll" />
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

        const artefacts = [
            {
                name: "container",
                hasPruneAll: false
            },
            {
                name: "image",
                hasPruneAll: true
            },
            {
                name: "network",
                hasPruneAll: false
            },
            {
                name: "volume",
                hasPruneAll: true
            },
        ];

        // State
        const processing = ref(false);
        const showSystemPruneDialog = ref(false);
        const activeArtefactIndex = ref(0);
        const artefactsData = reactive<Record<string, any>>({});
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
            startPruneAction();

            root.emitAgent(endpoint.value, "systemPrune", systemPruneData.all, systemPruneData.volumes, (res) => {
                stopPruneAction();
                root.toastRes(res);
                reloadArtefactsData();
            });
        }

        function startPruneAction() {
            processing.value = true;
            progressTerminal.value?.show();
        }

        function stopPruneAction() {
            processing.value = false;
            progressTerminal.value?.hideWithTimeout();
        }

        function reloadArtefactsData() {
            for (const artefact of artefacts) {
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
        provide("startPruneAction", startPruneAction);
        provide("stopPruneAction", stopPruneAction);

        return {
            processing,
            showSystemPruneDialog,
            artefacts,
            activeArtefactIndex,
            artefactsData,
            systemPruneData,
            endpoint,
            name,
            terminalName,
            progressTerminal,
            resetSystemPrune,
            systemPrune,
            startPruneAction,
            stopPruneAction,
            reloadArtefactsData
        };
    }
});
</script>

<style scoped lang="scss">
@import "../styles/vars.scss";

.action-icon {
    cursor: pointer;
    color: rgba(255, 255, 255, 0.3);
}

:deep(.active-artefact) {
  background: rgba(255, 255, 255, 0.5) !important;
  color: $dark-font-color2 !important;
  font-weight: bold;
}

</style>
