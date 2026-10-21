import { Knex } from "knex";

/**
 * Keys for the REST API.
 *
 * Only a hash of each key is stored: the key itself is shown once, when it is
 * created, and cannot be read back. The prefix is the first few characters,
 * kept so that a key can be told apart from the others in the list.
 * @param knex Knex instance
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("api_key", (table) => {
        table.increments("id");
        table.string("name", 255).notNullable();
        table.string("key_hash", 64).notNullable().unique();
        table.string("key_prefix", 16).notNullable();
        table.boolean("read_only").notNullable().defaultTo(false);
        table.string("created_at", 50).notNullable();
        table.string("last_used_at", 50);
    });
}

/**
 * @param knex Knex instance
 */
export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("api_key");
}
