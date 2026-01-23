<template>
    <div class="shadow-box mb-3" :class="{ 'sticky-shadow-box': embedded }" :style="boxStyle">
        <div class="list-header">
            <div class="d-flex align-items-center">
                <!-- TODO -->
                <button
                    v-if="false" class="btn btn-outline-normal ms-2" :class="{ 'active': selectMode }" type="button"
                    @click="selectMode = !selectMode"
                >
                    {{ $t("Select") }}
                </button>

                <div class="d-flex flex-grow-1">
                    <a v-if="searchText == ''" class="search-icon">
                        <font-awesome-icon icon="search" />
                    </a>
                    <a v-if="searchText != ''" class="search-icon" style="cursor: pointer" @click="clearSearchText">
                        <font-awesome-icon icon="times" />
                    </a>
                    <input v-model="searchText" class="form-control w-100" autocomplete="off" />
                </div>

                <!-- Dropdown for filter -->
                <BDropdown variant="link" placement="bottom-end" menu-class="filter-dropdown" toggle-class="filter-icon-container" no-caret>
                    <template #button-content>
                        <font-awesome-icon class="filter-icon" :class="{ 'filter-icon-active': stackFilter.isFilterSelected() }" icon="filter" />
                    </template>

                    <BDropdownItemButton :disabled="!stackFilter.isFilterSelected()" button-class="filter-dropdown-clear" @click="stackFilter.clear()">
                        <font-awesome-icon class="ms-1 me-2" icon="times" />{{ $t("clearFilter") }}
                    </BDropdownItemButton>

                    <BDropdownDivider></BDropdownDivider>

                    <template v-for="category in stackFilter.categories" :key="category">
                        <BDropdownGroup v-if="category.hasOptions()" :header="$tc(category.label, 2)">
                            <BDropdownForm v-for="(value, key) in category.options" :key="value" form-class="filter-option" @change="category.toggleSelected(value)" @click.stop>
                                <BFormCheckbox :checked="category.selected.has(value)">{{ $t(key) }}</BFormCheckbox>
                            </BDropdownForm>
                        </BDropdownGroup>
                    </template>
                </BDropdown>
            </div>

            <!-- TODO: Selection Controls -->
            <div v-if="selectMode && false" class="selection-controls px-2 pt-2">
                <input v-model="selectAll" class="form-check-input select-input" type="checkbox" />

                <button class="btn-outline-normal" @click="pauseDialog"><font-awesome-icon icon="pause" size="sm" /> {{
                    $t("Pause") }}</button>
                <button class="btn-outline-normal" @click="resumeSelected"><font-awesome-icon icon="play" size="sm" />
                    {{ $t("Resume") }}</button>

                <span v-if="selectedStackCount > 0">
                    {{ $t("selectedStackCount", [selectedStackCount]) }}
                </span>
            </div>
        </div>
        <div ref="stackList" class="stack-list" :class="{ scrollbar: embedded }" :style="stackListStyle">
            <div v-if="agentStackList[0] && agentStackList[0].stacks.length === 0" class="text-center mt-3">
                <router-link to="/compose">{{ $t("addFirstStackMsg") }}</router-link>
            </div>
            <div v-for="(agent, index) in agentStackList" :key="index" class="stack-list-inner">
                <div
                    v-if="agentCount > 1" class="p-2 agent-select"
                    @click="closedAgents.set(agent.endpoint, !closedAgents.get(agent.endpoint))"
                >
                    <span class="me-1">
                        <font-awesome-icon v-show="closedAgents.get(agent.endpoint)" icon="chevron-circle-right" />
                        <font-awesome-icon v-show="!closedAgents.get(agent.endpoint)" icon="chevron-circle-down" />
                    </span>
                    <span>{{ getAgentName(agent.endpoint) }}</span>
                </div>

                <!-- Tag groups -->
                <div v-show="agentCount === 1 || !closedAgents.get(agent.endpoint)">
                    <div v-for="(tagGroup, tagIndex) in agent.tagGroups" :key="tagIndex">
                        <!-- Tag header (collapsible) -->
                        <div
                            v-if="tagGroup.tag !== ''"
                            class="p-2 tag-folder"
                            @click="toggleTagFolder(agent.endpoint + '_' + tagGroup.tag)"
                        >
                            <span class="me-1">
                                <font-awesome-icon v-show="closedTags.get(agent.endpoint + '_' + tagGroup.tag) !== false" icon="chevron-right" />
                                <font-awesome-icon v-show="closedTags.get(agent.endpoint + '_' + tagGroup.tag) === false" icon="chevron-down" />
                            </span>
                            <font-awesome-icon icon="folder" class="me-1" />
                            <span>{{ tagGroup.tag }}</span>
                        </div>

                        <!-- Stacks in this tag group -->
                        <StackListItem
                            v-for="(item, stackIndex) in tagGroup.stacks"
                            v-show="tagGroup.tag === '' || closedTags.get(agent.endpoint + '_' + tagGroup.tag) === false"
                            :key="stackIndex"
                            :stack="item"
                            :isSelectMode="selectMode"
                            :isSelected="isSelected"
                            :select="select"
                            :deselect="deselect"
                            :style="tagGroup.tag !== '' ? 'padding-left: 20px;' : ''"
                        />
                    </div>
                </div>
            </div>
        </div>
    </div>

    <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseSelected">
        {{ $t("pauseStackMsg") }}
    </Confirm>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import Confirm from "./Confirm.vue";
import StackListItem from "./StackListItem.vue";
import { CREATED_FILE, CREATED_STACK, EXITED, RUNNING, RUNNING_AND_EXITED, StackFilter, StackStatusInfo, UNHEALTHY, UNKNOWN } from "../../../common/util-common";
import { SimpleStackData } from "../../../common/types";

export default defineComponent({
    components: {
        Confirm,
        StackListItem,
    },
    props: {
        /** Is the stack list embedded in a sidebar? */
        embedded: {
            type: Boolean,
        },
    },
    data() {
        return {
            searchText: "",
            selectMode: false,
            selectAll: false,
            filterDropdownOpen: false,
            disableSelectAllWatcher: false,
            selectedStacks: {},
            windowTop: 0,
            closedAgents: new Map(),
            closedTags: new Map(),
        };
    },
    computed: {
        /**
         * Improve the sticky appearance of the list by increasing its
         * height as user scrolls down.
         * Not used on mobile.
         * @returns {object} Style for stack list
         */
        boxStyle() {
            if (this.embedded) {
                if (window.innerWidth > 550) {
                    return {
                        height: `calc(100vh - 160px + ${this.windowTop}px)`,
                    };
                } else {
                    return {
                        height: "calc(100vh - 160px)",
                    };
                }
            } else {
                return "";
            }
        },

        stackFilter(): StackFilter {
            return this.$root.stackFilter;
        },

        agentCount() {
            return this.$root.agentCount;
        },

        /**
         * Returns a sorted list of stacks based on the applied filters and search text.
         * @returns {Array} The sorted list of stacks.
         */
        agentStackList(): {endpoint: string, stacks: SimpleStackData[]}[] {
            let result: SimpleStackData[] = Object.values(this.$root.completeStackList);

            result = result.filter(stack => {
                // filter by search text
                // finds stack name, tag name or tag value
                let searchTextMatch = true;
                if (this.searchText !== "") {
                    const loweredSearchText = this.searchText.toLowerCase();
                    searchTextMatch =
                        stack.name.toLowerCase().includes(loweredSearchText);
                    /* TODO
                        || stack.tags.find(tag => tag.name.toLowerCase().includes(loweredSearchText)
                            || tag.value?.toLowerCase().includes(loweredSearchText));
                    */
                }

                // filter by agent
                let agentMatch = true;
                if (this.stackFilter.agents.isFilterSelected()) {
                    agentMatch = this.stackFilter.agents.selected.has(stack.endpoint);
                }

                // filter by status
                let statusMatch = true;
                if (this.stackFilter.status.isFilterSelected()) {
                    statusMatch = this.stackFilter.status.selected.has(StackStatusInfo.get(stack.status).label);
                }

                let attributeMatch = true;
                if (this.stackFilter.attributes.isFilterSelected()) {
                    attributeMatch = false;
                    for (const attribute of this.stackFilter.attributes.selected) {
                        if ( stack[attribute as keyof SimpleStackData] === true) {
                            attributeMatch = true;
                        }
                    }
                }

                // filter by tags TODO
                let tagsMatch = true;
                /**
                if (this.filterState.tags != null && this.filterState.tags.length > 0) {
                    tagsMatch = stack.tags.map(tag => tag.tag_id) // convert to array of tag IDs
                        .filter(stackTagId => this.filterState.tags.includes(stackTagId)) // perform Array Intersaction between filter and stack's tags
                        .length > 0;
                }*/

                return searchTextMatch && agentMatch && statusMatch && attributeMatch && tagsMatch;
            });

            result.sort((m1, m2) => {

                // sort by managed by dockge
                if (m1.isManagedByDockge && !m2.isManagedByDockge) {
                    return -1;
                } else if (!m1.isManagedByDockge && m2.isManagedByDockge) {
                    return 1;
                }

                // treat RUNNING and RUNNING_AND_EXITED the same
                const status1 = m1.status !== RUNNING_AND_EXITED ? m1.status : RUNNING ;
                const status2 = m2.status !== RUNNING_AND_EXITED ? m2.status : RUNNING ;

                // sort by status
                if (status1 !== status2) {
                    if (status2 === UNHEALTHY) {
                        return 1;
                    } else if (status1 === UNHEALTHY) {
                        return -1;
                    } else if (status2 === RUNNING) {
                        return 1;
                    } else if (status1 === RUNNING) {
                        return -1;
                    } else if (status2 === EXITED) {
                        return 1;
                    } else if (status1 === EXITED) {
                        return -1;
                    } else if (status2 === CREATED_STACK) {
                        return 1;
                    } else if (status1 === CREATED_STACK) {
                        return -1;
                    } else if (status2 === CREATED_FILE) {
                        return 1;
                    } else if (status1 === CREATED_FILE) {
                        return -1;
                    } else if (status2 === UNKNOWN) {
                        return 1;
                    } else if (status1 === UNKNOWN) {
                        return -1;
                    }
                }
                return m1.name.localeCompare(m2.name);
            });

            // Group stacks by endpoint, sorting them so the local endpoint is first
            // and the rest are sorted alphabetically
            const resultByEndpoint: {endpoint: string, stacks: SimpleStackData[], tagGroups?: {tag: string, stacks: SimpleStackData[]}[]}[] = [
                ...result.reduce((acc, stack) => {
                    const endpoint = stack.endpoint;
                    let stacks = acc.get(endpoint);
                    if (!stacks) {
                        stacks = [];
                        acc.set(endpoint, stacks);
                    }
                    stacks.push(stack);
                    return acc;
                }, new Map<string, SimpleStackData[]>()).entries()
            ].map(([ endpoint, stacks ]) => {
                // Group stacks by tags within each endpoint
                const tagGroups = this.groupStacksByTags(stacks);
                return {
                    endpoint,
                    stacks,
                    tagGroups
                };
            }).sort((a, b) => {
                if (a.endpoint === "" && b.endpoint !== "") {
                    return -1;
                } else if (a.endpoint !== "" && b.endpoint === "") {
                    return 1;
                }
                return a.endpoint.localeCompare(b.endpoint);
            });

            return resultByEndpoint;
        },

        isDarkTheme() {
            return document.body.classList.contains("dark");
        },

        stackListStyle() {
            //let listHeaderHeight = 107;
            let listHeaderHeight = 60;

            if (this.selectMode) {
                listHeaderHeight += 42;
            }

            return {
                "height": `calc(100% - ${listHeaderHeight}px)`
            };
        },

        selectedStackCount() {
            return Object.keys(this.selectedStacks).length;
        },

        /**
         * Determines if any filters are active.
         * @returns {boolean} True if any filter is active, false otherwise.
         */
        filtersActive() {
            return this.filterState.status != null || this.filterState.active != null || this.filterState.tags != null || this.searchText !== "";
        }
    },
    watch: {
        $route() {
            console.log("route changed");
        },

        searchText() {
            for (let stack of this.agentStackList) {
                if (!this.selectedStacks[stack.id]) {
                    if (this.selectAll) {
                        this.disableSelectAllWatcher = true;
                        this.selectAll = false;
                    }
                    break;
                }
            }
        },
        selectAll() {
            if (!this.disableSelectAllWatcher) {
                this.selectedStacks = {};

                if (this.selectAll) {
                    this.agentStackList.forEach((item) => {
                        this.selectedStacks[item.id] = true;
                    });
                }
            } else {
                this.disableSelectAllWatcher = false;
            }
        },
        selectMode() {
            if (!this.selectMode) {
                this.selectAll = false;
                this.selectedStacks = {};
            }
        },
    },
    mounted() {
        if (this.embedded) {
            window.addEventListener("scroll", this.onScroll);
        }
    },
    beforeUnmount() {
        if (this.embedded) {
            window.removeEventListener("scroll", this.onScroll);
        }
    },
    methods: {
        /**
         * Handle user scroll
         * @returns {void}
         */
        onScroll() {
            if (window.top!.scrollY <= 133) {
                this.windowTop = window.top!.scrollY;
            } else {
                this.windowTop = 133;
            }
        },

        /**
         * Clear the search bar
         * @returns {void}
         */
        clearSearchText() {
            this.searchText = "";
        },
        /**
         * Deselect a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        deselect(id) {
            delete this.selectedStacks[id];
        },
        /**
         * Select a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        select(id) {
            this.selectedStacks[id] = true;
        },
        /**
         * Determine if stack is selected
         * @param {number} id ID of stack
         * @returns {bool} Is the stack selected?
         */
        isSelected(id) {
            return id in this.selectedStacks;
        },
        /**
         * Disable select mode and reset selection
         * @returns {void}
         */
        cancelSelectMode() {
            this.selectMode = false;
            this.selectedStacks = {};
        },
        /**
         * Show dialog to confirm pause
         * @returns {void}
         */
        pauseDialog() {
            this.$refs.confirmPause.show();
        },
        /**
         * Pause each selected stack
         * @returns {void}
         */
        pauseSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("pauseStack", id, () => { }));

            this.cancelSelectMode();
        },
        /**
         * Resume each selected stack
         * @returns {void}
         */
        resumeSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => !this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("resumeStack", id, () => { }));

            this.cancelSelectMode();
        },

        getAgentName(endpoint: string) {
            return this.$root.getAgentName(endpoint);
        },

        /**
         * Toggle tag folder open/closed state
         * @param {string} tagKey Tag identifier
         * @returns {void}
         */
        toggleTagFolder(tagKey: string) {
            const currentState = this.closedTags.get(tagKey);
            // Toggle between false (open) and true/undefined (closed)
            this.closedTags.set(tagKey, currentState === false ? true : false);
        },

        /**
         * Group stacks by tags
         * @param {SimpleStackData[]} stacks Array of stacks
         * @returns {Array} Tag groups with stacks
         */
        groupStacksByTags(stacks: SimpleStackData[]): {tag: string, stacks: SimpleStackData[]}[] {
            // Collect all unique tags
            const tagMap = new Map<string, SimpleStackData[]>();
            const untaggedStacks: SimpleStackData[] = [];

            stacks.forEach(stack => {
                if (stack.tags && stack.tags.length > 0) {
                    // Add stack to each of its tags
                    stack.tags.forEach(tag => {
                        if (!tagMap.has(tag)) {
                            tagMap.set(tag, []);
                        }
                        tagMap.get(tag)!.push(stack);
                    });
                } else {
                    untaggedStacks.push(stack);
                }
            });

            // Convert map to array and sort by tag name
            const tagGroups = Array.from(tagMap.entries())
                .map(([tag, stacks]) => ({ tag, stacks }))
                .sort((a, b) => a.tag.localeCompare(b.tag));

            // Add untagged stacks at the end if there are any
            if (untaggedStacks.length > 0) {
                tagGroups.push({ tag: '', stacks: untaggedStacks });
            }

            return tagGroups;
        }
    },
});
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.sticky-shadow-box {
    height: calc(100vh - 150px);
    position: sticky;
    top: 10px;
}

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.list-header {
    border-bottom: 1px solid #dee2e6;
    border-radius: 10px 10px 0 0;
    margin: -10px;
    margin-bottom: 10px;
    padding: 5px;

    .dark & {
        background-color: $dark-header-bg;
        border-bottom: 0;
    }
}

.search-icon {
    width: 40px;
    padding: 10px;
    color: #c0c0c0;

    // Clear filter button (X)
    svg[data-icon="times"] {
        cursor: pointer;
        transition: all ease-in-out 0.1s;

        &:hover {
            opacity: 0.5;
        }
    }
}

:deep(.filter-icon-container) {
    text-decoration: none;
    padding-right: 0px;
}

.filter-icon {
    padding: 10px;
    color: $dark-font-color3 !important;
    cursor: pointer;
    border: 1px solid transparent;
}

.filter-icon-active {
    color: $info !important;
    border: 1px solid $info;
    border-radius: 5px;
}

:deep(.filter-dropdown) {
    background-color: $dark-bg;
    border-color: $dark-font-color3;
    color: $dark-font-color;

    .dropdown-header {
        color: $dark-font-color;
        font-weight: bolder;
    }

    .form-check-input {
        border-color: $dark-font-color3;
    }
}

:deep(.filter-dropdown-clear) {
    color: $dark-font-color;

    &:disabled {
        color: $dark-font-color3;
    }

    &:hover {
        background-color: $dark-header-active-bg;
        color: $dark-font-color;
    }
}

:deep(.filter-option) {
    padding-top: 0.25rem !important;
    padding-bottom: 0.25rem !important;
}

.stack-item {
    width: 100%;
}

.tags {
    margin-top: 4px;
    padding-left: 67px;
    display: flex;
    flex-wrap: wrap;
    gap: 0;
}

.bottom-style {
    padding-left: 67px;
    margin-top: 5px;
}

.selection-controls {
    margin-top: 5px;
    display: flex;
    align-items: center;
    gap: 10px;
}

.agent-select {
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: $dark-font-color3;
    padding-left: 10px;
    padding-right: 10px;
    display: flex;
    align-items: center;
    user-select: none;
}

.tag-folder {
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    color: $dark-font-color;
    padding-left: 15px;
    padding-right: 10px;
    padding-top: 4px;
    padding-bottom: 4px;
    display: flex;
    align-items: center;
    user-select: none;
    transition: background-color 0.1s ease-in-out;

    &:hover {
        background-color: rgba(255, 255, 255, 0.05);
    }

    svg[data-icon="folder"] {
        color: #f0ad4e;
    }
}
</style>
