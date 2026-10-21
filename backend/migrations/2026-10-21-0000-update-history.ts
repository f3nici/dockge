import { Knex } from "knex";

/**
 * The update history: one row per update this instance ran on its own stacks.
 *
 * The columns are the ones finder39/dockge created its update_history table
 * with, so a database coming from there keeps its rows, and the table is only
 * created when it is not there already. service_name is new here: set when a
 * single service was updated rather than the whole stack.
 * @param knex Knex instance
 */
export async function up(knex: Knex): Promise<void> {
    if (!await knex.schema.hasTable("update_history")) {
        await knex.schema.createTable("update_history", (table) => {
            table.increments("id");
            table.string("stack_name", 255).notNullable();
            table.string("endpoint", 255).notNullable().defaultTo("");
            table.string("trigger_type", 50).notNullable();
            table.boolean("success").notNullable();
            table.text("output");
            table.text("error_message");
            table.string("started_at", 50).notNullable();
            table.string("completed_at", 50);
            table.integer("duration_ms");
        });
    }

    if (!await knex.schema.hasColumn("update_history", "service_name")) {
        await knex.schema.table("update_history", (table) => {
            table.string("service_name", 255);
        });
    }

    // Every page of the history is read newest first
    await knex.raw("CREATE INDEX IF NOT EXISTS update_history_started_at ON update_history (started_at)");
}

/**
 * @param knex Knex instance
 */
export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists("update_history");
}
