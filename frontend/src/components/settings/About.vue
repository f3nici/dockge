<template>
    <div class="d-flex justify-content-center align-items-center">
        <div class="logo d-flex flex-column justify-content-center align-items-center">
            <img class="my-4" width="200" height="200" src="/icon.svg" />
            <div class="fs-4 fw-bold">Dockge <span class="edition-tag">(f3nici-edition)</span></div>
            <div>{{ $t("Version") }}: V1.6</div>
            <div class="fork-info">Fork of <a href="https://github.com/louislam/dockge" target="_blank" rel="noopener">louislam/dockge</a></div>

            <div class="my-3 update-link"><a href="https://github.com/f3nici/dockge/releases" target="_blank" rel="noopener">{{ $t("Check Update On GitHub") }}</a></div>
        </div>
    </div>
</template>

<script>
export default {
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
</style>
