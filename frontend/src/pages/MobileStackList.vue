<template>
    <div class="mb-3 d-flex gap-2">
        <router-link to="/compose" class="btn btn-primary"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
        <button class="btn btn-normal" :disabled="checkingImageUpdates" @click="checkAllImageUpdates">
            <font-awesome-icon icon="arrows-rotate" :spin="checkingImageUpdates" class="me-1" />{{ $t("checkForUpdates") }}
        </button>
    </div>
    <StackList :embedded="false" />
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

    watch: {
        "$root.isMobile": {
            handler() {
                if (!this.$root.isMobile) {
                    this.$router.replace("/");
                }
            },
            deep: true,
        },
    },

    methods: {
        /**
         * Trigger an on-demand image update check for every stack on every
         * online endpoint (the local master and all connected agents).
         */
        checkAllImageUpdates() {
            const endpoints = Object.keys(this.$root.agentList);

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
    }

};
</script>
