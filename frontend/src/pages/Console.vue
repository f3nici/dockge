<template>
    <transition name="slide-fade" appear>
        <div v-if="!processing">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h1 class="mb-0">{{ $t("console") }}</h1>
                <button v-if="enableConsole" class="btn btn-outline-secondary" @click="clearConsole">
                    <font-awesome-icon icon="trash" class="me-1" /> Clear
                </button>
            </div>

            <Terminal v-if="enableConsole" ref="terminal" class="terminal" :rows="20" mode="mainTerminal" name="console" :endpoint="endpoint"></Terminal>

            <div v-else class="alert alert-warning shadow-box" role="alert">
                <h4 class="alert-heading">{{ $t("Console is not enabled") }}</h4>
                <p v-html="$t('ConsoleNotEnabledMSG1')"></p>
                <p v-html="$t('ConsoleNotEnabledMSG2')"></p>
                <p v-html="$t('ConsoleNotEnabledMSG3')"></p>
            </div>
        </div>
    </transition>
</template>

<script>
export default {
    components: {
    },
    data() {
        return {
            processing: true,
            enableConsole: false,
        };
    },
    computed: {
        endpoint() {
            return this.$route.params.endpoint || "";
        },
    },
    mounted() {
        this.$root.emitAgent(this.endpoint, "checkMainTerminal", (res) => {
            this.enableConsole = res.ok;
            this.processing = false;
        });
    },
    methods: {
        clearConsole() {
            // Clear the server-side buffer
            this.$root.emitAgent(this.endpoint, "clearTerminal", "console", () => {});
            // Clear the local terminal display
            if (this.$refs.terminal) {
                this.$refs.terminal.clearTerminal();
            }
        }
    }
};
</script>

<style scoped lang="scss">
.terminal {
    height: 410px;
}
</style>
