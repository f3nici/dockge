<template>
    <div class="container-fluid">
        <div class="row">
            <!-- Show stack list as side component only on bigger screens -->
            <div v-if="!$root.isMobile" class="col-12 col-md-4 col-xl-3">
                <div class="mb-3 d-flex gap-2">
                    <router-link to="/compose" class="btn btn-primary"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
                    <button class="btn btn-normal" data-toggle="tooltip" :title="$t('tooltipCheckAllImageUpdates')" :disabled="checkingImageUpdates" @click="checkAllImageUpdates">
                        <font-awesome-icon icon="arrows-rotate" :spin="checkingImageUpdates" class="me-1" />{{ $t("checkForUpdates") }}
                    </button>
                </div>
                <StackList :embedded="true" />
            </div>

            <div ref="container" class="col-12 col-md-8 col-xl-9 mb-3">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" />
            </div>
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

export default {
    components: {
        StackList,
    },

    data() {
        return {
            checkingImageUpdates: false,
        };
    },

    computed: {
    },

    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },

    methods: {
        /**
         * Trigger an on-demand image update check for every stack on every
         * online endpoint (the local master and all connected agents).
         */
        checkAllImageUpdates() {
            const endpoints = Object.keys(this.$root.agentList);

            // Master endpoint is "" (local); only include agents that are online
            const targets = endpoints.filter(
                (ep) => ep === "" || this.$root.agentStatusList[ep] === "online"
            );

            if (targets.length === 0) {
                targets.push("");
            }

            this.checkingImageUpdates = true;
            let pending = targets.length;

            for (const endpoint of targets) {
                this.$root.emitAgent(endpoint, "checkAllStacksImageUpdates", (res) => {
                    pending--;
                    if (res && !res.ok) {
                        this.$root.toastRes(res);
                    }
                    if (pending <= 0) {
                        this.checkingImageUpdates = false;
                        this.$root.toastSuccess("checkedImageUpdates");
                    }
                });
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.container-fluid {
    width: 98%;
}
</style>
