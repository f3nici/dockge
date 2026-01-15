import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Initialize default notification settings
    const defaultSettings = [
        {
            key: "enabled",
            value: JSON.stringify(false),
            type: "notifications"
        },
        {
            key: "ntfyServerUrl",
            value: JSON.stringify("https://ntfy.sh"),
            type: "notifications"
        },
        {
            key: "ntfyTopic",
            value: JSON.stringify(""),
            type: "notifications"
        },
        {
            key: "enabledEvents",
            value: JSON.stringify([]),
            type: "notifications"
        }
    ];

    for (const setting of defaultSettings) {
        const exists = await knex("setting").where("key", setting.key).first();
        if (!exists) {
            await knex("setting").insert(setting);
        }
    }
}

export async function down(knex: Knex): Promise<void> {
    // Remove notification settings
    await knex("setting").where("type", "notifications").delete();
}
