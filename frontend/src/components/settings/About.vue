<template>
    <div class="d-flex justify-content-center align-items-center">
        <div class="logo d-flex flex-column justify-content-center align-items-center">
            <img class="my-4" width="200" height="200" src="/icon.svg" />
            <div class="fs-4 fw-bold">Dockge <span class="edition-tag">(f3nici-edition)</span></div>
            <div>{{ $t("Version") }}: V1.5</div>
            <div class="fork-info">Fork of <a href="https://github.com/louislam/dockge" target="_blank" rel="noopener">louislam/dockge</a></div>

            <div class="my-3 update-link"><a href="https://github.com/f3nici/dockge/releases" target="_blank" rel="noopener">{{ $t("Check Update On GitHub") }}</a></div>

            <div class="mt-3 update-options">
                <div class="update-options-title">Docker Image Update Checks</div>
                <div class="form-check">
                    <label><input v-model="settings.checkLatest" type="checkbox" @change="saveSettings()" /> Check for updates to <code>f3nici/dockge:latest</code></label>
                </div>
                <div class="form-check">
                    <label><input v-model="settings.checkTesting" type="checkbox" @change="saveSettings()" /> Check for updates to <code>f3nici/dockge:testing</code></label>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
    },

    watch: {

    }
};
</script>

<style lang="scss" scoped>
.logo {
    margin: 4em 1em;
}

.edition-tag {
    font-size: 0.6em;
    font-weight: normal;
    opacity: 0.7;
}

.update-link {
    font-size: 0.8em;
}

.fork-info {
    font-size: 0.9em;
    color: #666666;
    margin-top: 0.5em;

    .dark & {
        color: #999999;
    }

    a {
        color: inherit;
        text-decoration: underline;
    }
}

.update-options {
    text-align: left;
    padding: 1em;
    border: 1px solid #dee2e6;
    border-radius: 8px;

    .dark & {
        border-color: #444;
    }

    .update-options-title {
        font-weight: bold;
        margin-bottom: 0.5em;
    }

    .form-check {
        margin-top: 0.5em;
    }

    code {
        background-color: rgba(0, 0, 0, 0.05);
        padding: 0.2em 0.4em;
        border-radius: 4px;

        .dark & {
            background-color: rgba(255, 255, 255, 0.1);
        }
    }
}
</style>
