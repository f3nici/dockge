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
                    <th v-for="(title, index) in dataHeader" :key="index" class="sortable-header" scope="col" @click="toggleSort(title)">{{ title }} <span class="sort-symbol">{{ sortCol === title ? (sortDir === "UP" ? "&nbsp;▲" : "&nbsp;▼" ) : "&nbsp;&nbsp;" }}</span></th>
                    <th scope="col"></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="(item, itemIndex) in tableData" :key="itemIndex">
                    <td scope="col">
                        <input
                            v-model="selectedItems"
                            class="form-check-input"
                            type="checkbox"
                            :value="item.id"
                        />
                    </td>
                    <td v-for="(value, valueIndex) in item.values" :key="valueIndex" class="artefact-cell">{{ getValue(value) }}</td>
                    <td>
                        <span v-if="item.dangling" class="badge bg-info">{{ item.danglingLabel }}</span>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<script lang="ts" setup>
import { computed, ref, Ref, reactive, onMounted, inject, getCurrentInstance } from "vue";
import { DockerArtefactAction, DockerArtefactData, DockerArtefactInfo, DockerArtefactItem } from "../../../common/types";

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

// Local types
type SortDir = "UP" | "DOWN";

// Local reactive state
const fetchingData = ref(true);
const data = ref<DockerArtefactData>({
    info: props.artefact,
    data: []
});
const dataMap = reactive(new Map<string, DockerArtefactItem>());
const tableData = ref<DockerArtefactItem[]>([]);
const sortCol = ref<string>("");
const sortDir = ref<SortDir>("UP");
const selectedItems = ref<string[]>([]);
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
        dataMap.clear();
        for (const item of data.value.data) {
            dataMap.set(item.id, item);
        }

        if (sortCol.value === "") {
            sortCol.value = dataHeader.value.length > 0 ? dataHeader.value[0] : "";
        }
        sortData();

        selectedItems.value = [];
    });
}

function sortData() {
    if (sortCol.value !== "") {
        tableData.value = Array.from(dataMap.values()).sort((i1, i2) => {
            let v1 = getValue(i1.values[sortCol.value], true);
            let v2 = getValue(i2.values[sortCol.value], true);

            const upSort = sortDir.value === "UP";

            if (typeof (v1) === "string") {
                v2 = v2 as string;
                return (upSort ? v1 : v2).localeCompare(upSort ? v2 : v1);
            } else {
                v2 = v2 as number;
                return (upSort ? v1 : v2) - (upSort ? v2 : v1);
            }
        });
    }
}

function toggleSort(col: string) {
    if (sortCol.value != col) {
        sortCol.value = col;
        sortDir.value = "UP";
    } else {
        sortDir.value = (sortDir.value === "UP" ? "DOWN" : "UP");
    }

    sortData();
}

function getValue(value: string | [string, string] | [string, number], sortValue = false): string | number {
    if (Array.isArray(value)) {
        return sortValue ? value[1] : value[0];
    } else {
        return value;
    }
}

function resetPruneDialog() {
    pruneDialogData.all = false;
}

function checkOpenPullDialog() {
    const selectedDanglingImages = selectedItems.value
        .filter(id => dataMap.get(id)!.excludedActions.includes(DockerArtefactAction.Pull));

    if (selectedDanglingImages.length > 0) {
        const danglingImageList = [ "<ul>" ];
        for (const id of selectedDanglingImages) {
            danglingImageList.push(`<li>${dataMap.get(id)!.actionId}</li>`);
        }
        danglingImageList.push("</ul>");
        pullDialogData.danglingImagesList = danglingImageList.join("");

        selectedItems.value = selectedItems.value.filter(id => !selectedDanglingImages.includes(id));

        showPullDialog.value = true;
    } else {
        executeAction(DockerArtefactAction.Pull);
    }
}

function executeAction(action: DockerArtefactAction) {
    startAction?.();

    root.emitAgent(props.endpoint, "executeDockerArtefactAction", props.artefact.name, action, selectedItems.value.map(id => dataMap.get(id)?.actionId), (res) => {
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

    .sortable-header {
        cursor: pointer;
    }

    .sort-symbol {
        color: rgba(255, 255, 255, 0.3);
        font-family: monospace;
    }

</style>
