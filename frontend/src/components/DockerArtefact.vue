<template>
    <button class="btn btn-primary btn-sm mb-3" data-toggle="tooltip" :title="$t('openPruneDialog')" :disabled="processing" @click="showPruneDialog = true">
        <font-awesome-icon icon="wrench" class="me-1" />
        <span>{{ $t("prune") }}</span>
    </button>

    <!-- Prune form -->
    <BModal id="prune" v-model="showPruneDialog" :title="$t('prune') + ' ' + $tc(artefact, 2)" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('prune')" okVariant="danger" @ok="prune" @show="resetPrune" @hidden="resetPrune">
        <p class="mb-3" v-html="$t(artefact + 'PruneMsg')"></p>

        <form @submit.prevent>
            <div v-if="hasPruneAll" class="form-check form-switch">
                <input
                    id="pruneAll"
                    v-model="pruneData.all"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="pruneAll">
                    {{ $t(artefact + "PruneAll") }}
                </label>
            </div>
        </form>
    </BModal>

    <div v-if="fetchingData">{{ $t("fetchingData") }}</div>
    <div v-else class="table-responsive">
        <table class="table table-dark ">
            <thead>
                <tr>
                    <th v-for="(title, index) in (data as DockerArtefactData).header" :key="index" scope="col">{{ title }}</th>
                    <th scope="col"></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(row, rowIndex) in (data as DockerArtefactData).data" :key="rowIndex">
                    <td v-for="(value, valueIndex) in row.values" :key="valueIndex" class="artefact-cell">{{ value }}</td>
                    <td>
                        <span v-if="row.dangling" class="badge bg-info">{{ row.danglingLabel }}</span>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<script lang="ts" setup>
import { ref, Ref, reactive, onMounted, inject, getCurrentInstance } from "vue";
import { DockerArtefactData } from "../../../common/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = getCurrentInstance()?.proxy?.$root as any;

const props = defineProps<{
  endpoint: string;
  artefact: string;
  hasPruneAll: boolean;
}>();

// Injected from parent
const processing = inject("processing") as Ref<boolean>;
const startPruneAction = inject("startPruneAction") as () => void;
const stopPruneAction = inject("stopPruneAction") as () => void;

// Local reactive state
const fetchingData = ref(true);
const data = ref<DockerArtefactData>({
    header: [],
    data: []
});
const showPruneDialog = ref(false);
const pruneData = reactive({ all: false });

// Methods
function loadData() {
    console.debug("Loading data for " + props.artefact);

    fetchingData.value = true;

    root.emitAgent(props.endpoint, "getDockerArtefactData", props.artefact, (res) => {
        fetchingData.value = false;
        data.value = res.data;
    });
}

function resetPrune() {
    pruneData.all = false;
}

function prune() {
    startPruneAction?.();

    root.emitAgent(props.endpoint, "prune", props.artefact, pruneData.all, (res) => {
        stopPruneAction?.();
        root.toastRes(res);
        loadData();
    });
}

// Lifecycle
onMounted(() => {
    loadData();
});

</script>

<style lang="scss" scoped>
    @import "../styles/vars.scss";

    .artefact-cell {
        max-width: 200px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

</style>
