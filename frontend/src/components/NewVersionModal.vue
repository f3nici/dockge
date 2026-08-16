<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-scrollable modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        <font-awesome-icon icon="arrow-up" class="me-2" />
                        {{ $t("newVersionTitle") }}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>

                <div class="modal-body">
                    <div class="version-summary mb-3">
                        <span class="current-version">{{ currentVersion }}</span>
                        <font-awesome-icon icon="arrow-right" class="mx-2" />
                        <span class="new-version">{{ latestVersion }}</span>
                        <div v-if="publishedAt" class="published-at">
                            {{ $t("newVersionReleased", { date: publishedAt }) }}
                        </div>
                    </div>

                    <div v-if="blocks.length > 0" class="release-notes">
                        <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
                            <component :is="headingTag(block.level)" v-if="block.type === 'heading'" class="notes-heading">
                                <ReleaseNotesSpans :spans="block.spans" />
                            </component>

                            <ul v-else-if="block.type === 'list'" class="notes-list">
                                <li v-for="(item, itemIndex) in block.items" :key="itemIndex">
                                    <ReleaseNotesSpans :spans="item" />
                                </li>
                            </ul>

                            <p v-else class="notes-paragraph">
                                <ReleaseNotesSpans :spans="block.spans" />
                            </p>
                        </template>

                        <p v-if="notesTruncated" class="notes-truncated">
                            {{ $t("newVersionNotesTruncated") }}
                        </p>
                    </div>

                    <p v-else class="text-muted">
                        {{ $t("newVersionNoNotes") }}
                    </p>
                </div>

                <div class="modal-footer">
                    <a :href="releaseUrl" target="_blank" rel="noopener" class="btn btn-primary">
                        <font-awesome-icon icon="external-link-square-alt" class="me-1" />
                        {{ $t("newVersionViewOnGitHub") }}
                    </a>
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                        {{ $t("newVersionLater") }}
                    </button>
                    <button type="button" class="btn btn-normal" data-bs-dismiss="modal" @click="skipVersion">
                        {{ $t("newVersionSkip") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import dayjs from "dayjs";
import { parseReleaseNotes } from "../../../common/release-notes";
import ReleaseNotesSpans from "./ReleaseNotesSpans.vue";

const DISMISSED_VERSION_KEY = "dismissedUpdateVersion";
const RELEASES_URL = "https://github.com/f3nici/dockge/releases";

export default {
    components: {
        ReleaseNotesSpans,
    },

    data() {
        return {
            modal: null,
            // Set once the dialog has opened itself, so a later "info" push (the
            // server re-sends it on reconnect) does not reopen what the user just
            // closed.
            autoShown: false,
        };
    },

    computed: {
        release() {
            return this.$root.info.latestRelease;
        },

        hasUpdate() {
            return !!this.$root.info.hasUpdate;
        },

        currentVersion() {
            const version = this.$root.info.version;
            return version ? `V${version}` : "";
        },

        latestVersion() {
            return this.release?.version || this.$root.info.latestVersion || "";
        },

        releaseUrl() {
            return this.release?.url || RELEASES_URL;
        },

        notesTruncated() {
            return !!this.release?.notesTruncated;
        },

        publishedAt() {
            if (!this.release?.publishedAt) {
                return "";
            }
            const published = dayjs(this.release.publishedAt);
            return published.isValid() ? published.format("YYYY-MM-DD") : "";
        },

        blocks() {
            return parseReleaseNotes(this.release?.notes || "");
        },

        /**
         * Whether the dialog should open on its own: there is an update, and the
         * user has not already skipped this exact version.
         */
        shouldAutoShow() {
            if (!this.hasUpdate || !this.latestVersion) {
                return false;
            }
            return localStorage.getItem(DISMISSED_VERSION_KEY) !== this.latestVersion;
        },
    },

    watch: {
        shouldAutoShow: {
            handler(shouldShow) {
                if (shouldShow && !this.autoShown) {
                    this.autoShown = true;
                    this.show();
                }
            },
            immediate: true,
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);

        // The update may already have been known before this component existed,
        // in which case the watcher above has nothing left to react to.
        if (this.shouldAutoShow && !this.autoShown) {
            this.autoShown = true;
            this.show();
        }
    },

    beforeUnmount() {
        // This component is unmounted on logout, which can happen while the dialog
        // is still open. dispose() takes the backdrop with it, but the scroll lock
        // Bootstrap put on <body> is only undone by a normal hide(), and leaving it
        // behind would freeze the login page underneath.
        if (this.modal) {
            this.modal.dispose();
            this.modal = null;
        }

        document.body.classList.remove("modal-open");
        document.body.style.removeProperty("overflow");
        document.body.style.removeProperty("padding-right");
    },

    methods: {
        /**
         * Open the dialog.
         * @returns {void}
         */
        show() {
            // The watcher can fire before mounted() has created the Modal.
            this.$nextTick(() => {
                this.modal?.show();
            });
        },

        /**
         * Heading tag for a markdown heading level. Release notes routinely start
         * at `##`, so the levels are compressed into the small end of the scale to
         * keep them from dwarfing the dialog title.
         * @param {number} level Markdown heading level (1-6)
         * @returns {string} The tag to render
         */
        headingTag(level) {
            return level <= 2 ? "h6" : "div";
        },

        /**
         * Remember this version as skipped, so it stops opening the dialog.
         * @returns {void}
         */
        skipVersion() {
            if (this.latestVersion) {
                localStorage.setItem(DISMISSED_VERSION_KEY, this.latestVersion);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.version-summary {
    font-size: 1.1em;

    .current-version {
        opacity: 0.7;
    }

    .new-version {
        font-weight: bold;
        color: $primary;
    }

    .published-at {
        font-size: 0.8em;
        opacity: 0.7;
        margin-top: 0.25em;
    }
}

.release-notes {
    // Long changelogs scroll inside the dialog rather than stretching it.
    word-break: break-word;

    .notes-heading {
        margin-top: 1em;
        margin-bottom: 0.4em;
        font-weight: bold;

        &:first-child {
            margin-top: 0;
        }
    }

    .notes-paragraph {
        margin-bottom: 0.3em;
    }

    .notes-list {
        margin-bottom: 0.6em;
        padding-left: 1.4em;
    }

    .notes-truncated {
        margin-top: 1em;
        font-style: italic;
        opacity: 0.7;
    }
}
</style>
