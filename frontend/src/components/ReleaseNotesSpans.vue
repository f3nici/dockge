<template>
    <!--
        Renders the inline spans of a release-notes line.

        Everything goes through text interpolation, never v-html, so a release
        body cannot inject markup. Link hrefs come from the parser, which only
        matches http(s) URLs.
    -->
    <template v-for="(span, index) in spans" :key="index">
        <strong v-if="span.type === 'strong'">{{ span.text }}</strong>
        <code v-else-if="span.type === 'code'">{{ span.text }}</code>
        <a v-else-if="span.type === 'link'" :href="span.href" target="_blank" rel="noopener noreferrer">{{ span.text }}</a>
        <template v-else>{{ span.text }}</template>
    </template>
</template>

<script>
export default {
    props: {
        /** Inline spans produced by parseReleaseNotes() */
        spans: {
            type: Array,
            required: true,
        },
    },
};
</script>
