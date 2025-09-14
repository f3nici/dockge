<template>
    <div>
        <router-link to="/compose" class="btn btn-primary mb-3"><font-awesome-icon icon="plus" /> {{ $t("compose") }}</router-link>
    </div>
    <StackList :embedded="false" />
</template>

<script>
import StackList from "../components/StackList.vue";

export default {

    components: {
        StackList,
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
    }

};
</script>
