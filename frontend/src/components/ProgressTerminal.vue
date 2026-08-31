<template>
    <div class="shadow-box">
        <div class="progress-terminal-header mb-1" @click="showProgressTerminal = !showProgressTerminal">
            <font-awesome-icon :icon="showProgressTerminal ? 'chevron-down' : 'chevron-right'" class="me-2" />
            {{ $t("terminal") }}
            <span v-if="status" class="status ms-2">
                <font-awesome-icon icon="spinner" spin class="me-1" />{{ status }}
            </span>
        </div>
        <transition name="slide-fade" appear>
            <Terminal
                v-show="showProgressTerminal"
                ref="progressTerminal"
                class="terminal"
                :name="name"
                :endpoint="endpoint"
                :rows="rows"
            ></Terminal>
        </transition>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { PROGRESS_TERMINAL_ROWS } from "../../../common/util-common";
import Terminal from "./Terminal.vue";

let autoHideTerminalTimout: ReturnType<typeof setTimeout> | undefined = undefined;

export default defineComponent({
    components: {
        Terminal
    },

    props: {
        name: {
            type: String,
            required: true
        },
        endpoint: {
            type: String,
            required: true
        },
        rows: {
            type: Number,
            default: PROGRESS_TERMINAL_ROWS
        },
        autoHideTimeout: {
            type: Number,
            default: 10000
        },
        // What is running right now, shown next to the header so the operation
        // is named even while a step of it produces no output yet
        status: {
            type: String,
            default: ""
        }
    },

    data() {
        return {
            showProgressTerminal: false,
        };
    },

    computed: {
        progressTerminal(): typeof Terminal {
            return this.$refs.progressTerminal as typeof Terminal;
        }
    },

    mounted() {
    },

    methods: {
        show() {
            this.progressTerminal.bind(this.endpoint, this.name);
            this.progressTerminal.clearTerminal();
            this.showProgressTerminal = true;
            clearTimeout(autoHideTerminalTimout);
        },

        hideWithTimeout() {
            if (this.autoHideTimeout > 0) {
                autoHideTerminalTimout = setTimeout(async () => {
                    this.showProgressTerminal = false;
                }, this.autoHideTimeout);
            }
        },
    }
});
</script>

<style lang="scss" scoped>
    @import "../styles/vars.scss";

    .progress-terminal-header {
        cursor: pointer;

        .status {
            color: #6c757d;
        }
    }

</style>
