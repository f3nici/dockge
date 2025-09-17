<template>
    <div class="d-flex gap-3">
        <button v-if="artefact.actions.includes(DockerArtefactAction.Prune)" class="btn btn-primary btn-sm mb-3" data-toggle="tooltip" :title="$t('tooltipOpenPruneDialog')" :disabled="processing" @click="showPruneDialog = true">
            <font-awesome-icon icon="wrench" class="me-1" />
            <span>{{ $t("prune") }}</span>
        </button>

        <button v-if="artefact.actions.includes(DockerArtefactAction.Pull)" class="btn btn-primary btn-sm mb-3" data-toggle="tooltip" :title="$t('tooltipPullSelected')" :disabled="processing || selectedItems.length === 0" @click="checkOpenPullDialog">
            <font-awesome-icon icon="cloud-arrow-down" class="me-1" />
            <span>{{ $t("pull") }}</span>
        </button>

        <button v-if="artefact.actions.includes(DockerArtefactAction.Remove)" class="btn btn-danger btn-sm mb-3" data-toggle="tooltip" :title="$t('tooltipDeleteSelected')" :disabled="processing || selectedItems.length === 0" @click="showDeleteDialog = true">
            <font-awesome-icon icon="trash" class="me-1" />
            <span>{{ $t("delete") }}</span>
        </button>
    </div>

    <!-- Prune dialog -->
    <BModal v-model="showPruneDialog" :title="$t('prune') + ' ' + $tc(artefact.name, 2)" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('prune')" okVariant="danger" @ok="executeAction(pruneDialogData.all ? DockerArtefactAction.PruneAll : DockerArtefactAction.Prune)" @show="resetPruneDialog" @hidden="resetPruneDialog">
        <p class="mb-3" v-html="$t(artefact.name + 'PruneMsg')"></p>

        <form @submit.prevent>
            <div v-if="artefact.actions.includes(DockerArtefactAction.PruneAll)" class="form-check form-switch">
                <input
                    id="pruneAll"
                    v-model="pruneDialogData.all"
                    class="form-check-input"
                    type="checkbox"
                />
                <label class="form-check-label" for="pruneAll">
                    {{ $t(artefact.name + "PruneAll") }}
                </label>
            </div>
        </form>
    </BModal>

    <!-- Pull dialog -->
    <BModal v-model="showPullDialog" :title="$t('pull') + ' ' + $tc(artefact.name, 2)" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('pull')" okVariant="primary" :ok-disabled="selectedItems.length === 0" @ok="executeAction(DockerArtefactAction.Pull)">
        <p v-html="$t('imagePullInfoMsg')"></p>
        <p v-html="pullDialogData.danglingImagesList"></p>
    </BModal>

    <!-- Delete dialog -->
    <BModal v-model="showDeleteDialog" :title="$t('delete') + ' ' + $tc(artefact.name, 2)" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('delete')" okVariant="danger" @ok="executeAction(DockerArtefactAction.Remove)">
        <p class="mb-3" v-html="$t(artefact.name + 'DeleteMsg')"></p>
    </BModal>

    <div v-if="fetchingData">{{ $t("fetchingData") }}</div>

    <div v-else class="table-responsive">
        <table class="table table-dark ">
            <thead>
                <tr>
                    <th scope="col"></th>
                    <th v-for="(title, index) in dataHeader" :key="index" scope="col">{{ title }}</th>
                    <th scope="col"></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(row, rowIndex) in data.data" :key="rowIndex">
                    <td scope="col">
                        <input
                            v-model="selectedItems"
                            class="form-check-input"
                            type="checkbox"
                            :value="rowIndex"
                        />
                    </td>
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
import { computed, ref, Ref, reactive, onMounted, inject, getCurrentInstance } from "vue";
import { DockerArtefactAction, DockerArtefactData, DockerArtefactInfo } from "../../../common/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = getCurrentInstance()?.proxy?.$root as any;

const props = defineProps<{
  endpoint: string;
  artefact: DockerArtefactInfo;
}>();

// Injected from parent
const processing = inject("processing") as Ref<boolean>;
const startAction = inject("startAction") as () => void;
const stopAction = inject("stopAction") as () => void;

// Local reactive state
const fetchingData = ref(true);
const data = ref<DockerArtefactData>({
    info: props.artefact,
    data: []
});
const selectedItems = ref<number[]>([]);
const showPruneDialog = ref(false);
const pruneDialogData = reactive({ all: false });
const showPullDialog = ref(false);
const pullDialogData = reactive({ danglingImagesList: "" });
const showDeleteDialog = ref(false);

// Computed
const dataHeader = computed(() => data.value.data.length > 0 ? Object.keys(data.value.data[0].values) : []);

// Methods
function loadData() {
    console.debug("Loading data for " + props.artefact.name);

    fetchingData.value = true;

    root.emitAgent(props.endpoint, "getDockerArtefactData", props.artefact.name, (res) => {
        fetchingData.value = false;
        data.value = res.data;
        selectedItems.value = [];
    });
}

function resetPruneDialog() {
    pruneDialogData.all = false;
}

function checkOpenPullDialog() {
    const selectedDanglingImages = selectedItems.value
        .filter(i => data.value.data[i].excludedActions.includes(DockerArtefactAction.Pull));

    if (selectedDanglingImages.length > 0) {
        const danglingImageList = [ "<ul>" ];
        for (const i of selectedDanglingImages) {
            danglingImageList.push(`<li>${data.value.data[i].id}</li>`);
        }
        danglingImageList.push("</ul>");
        pullDialogData.danglingImagesList = danglingImageList.join("");

        selectedItems.value = selectedItems.value.filter(i => !selectedDanglingImages.includes(i));

        showPullDialog.value = true;
    } else {
        executeAction(DockerArtefactAction.Pull);
    }
}

function executeAction(action: DockerArtefactAction) {
    startAction?.();

    root.emitAgent(props.endpoint, "executeDockerArtefactAction", props.artefact.name, action, selectedItems.value.map(i => data.value.data[i].id), (res) => {
        stopAction?.();
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
