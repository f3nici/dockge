import { Knex } from "knex";

/**
 * Keys the notification settings used to be stored under, and what they are
 * called now.
 */
const RENAMES: Record<string, string> = {
    enabled: "notificationEnabled",
    enabledEvents: "notificationEnabledEvents",
};

/**
 * Give the notification settings keys of their own.
 *
 * `setting.key` is unique across every type, so the generic `enabled` and
 * `enabledEvents` claimed names another feature could later want. A second
 * feature writing `enabled` under its own type would not overwrite this row -
 * Settings.setSettings skips a key stored under a different type - it would
 * silently fail to save at all.
 *
 * The ntfy keys keep their names: they are already namespaced by the prefix.
 * @param knex Knex instance
 */
export async function up(knex: Knex): Promise<void> {
    for (const [ oldKey, newKey ] of Object.entries(RENAMES)) {
        await knex("setting")
            .where("type", "notifications")
            .where("key", oldKey)
            .update({ key: newKey });
    }
}

/**
 * Put the generic key names back.
 * @param knex Knex instance
 */
export async function down(knex: Knex): Promise<void> {
    for (const [ oldKey, newKey ] of Object.entries(RENAMES)) {
        await knex("setting")
            .where("type", "notifications")
            .where("key", newKey)
            .update({ key: oldKey });
    }
}
