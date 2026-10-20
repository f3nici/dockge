<template>
    <div class="d-flex flex-wrap column-gap-3 stats">
        <div v-if="stats.cpuPerc !== null" :title="$t('hostStatsCpuTooltip', [ stats.cpuCount ])">
            {{ $t("cpu") }}: {{ formatPercent(stats.cpuPerc) }}
        </div>
        <div v-if="stats.memTotal > 0" :title="$t('hostStatsUsedTooltip', [ formatPercent(stats.memUsed / stats.memTotal * 100) ])">
            {{ $t("memoryAbbreviated") }}: {{ formatBytes(stats.memUsed) }} / {{ formatBytes(stats.memTotal) }}
        </div>
        <div v-if="stats.diskUsed !== null && stats.diskTotal" :title="$t('hostStatsDiskTooltip', [ formatPercent(stats.diskUsed / stats.diskTotal * 100), stats.diskPath ])">
            {{ $t("disk") }}: {{ formatBytes(stats.diskUsed) }} / {{ formatBytes(stats.diskTotal) }}
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, PropType } from "vue";
import { HostStatsData } from "../../../common/types";
import { formatBytes, formatPercent } from "../../../common/util-common";

export default defineComponent({
    props: {
        stats: {
            type: Object as PropType<HostStatsData>,
            required: true
        }
    },

    methods: {
        formatBytes,
        formatPercent,
    },
});
</script>

<style lang="scss" scoped>
.stats {
    font-size: 0.8rem;
    color: #6c757d;
}
</style>
