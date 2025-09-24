<template>
    <span :class="className">{{ $t(info.label) }}</span>
</template>

<script lang="ts">
import { defineComponent, PropType } from "vue";
import { StackStatusInfo } from "../../../common/util-common";
import { SimpleStackData } from "../../../common/types";

export default defineComponent({
    props: {
        stack: {
            type: Object as PropType<SimpleStackData>,
            default: null,
        },
        fixedWidth: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        uptime() {
            return this.$t("notAvailableShort");
        },

        info() {
            return StackStatusInfo.get(this.stack?.status);
        },

        className() {
            let className = `badge rounded-pill bg-${this.info.badgeColor}`;

            if (this.fixedWidth) {
                className += " fixed-width";
            }
            return className;
        },
    },
});
</script>

<style scoped>
.badge {
    min-width: 62px;

}

.fixed-width {
    width: 62px;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
