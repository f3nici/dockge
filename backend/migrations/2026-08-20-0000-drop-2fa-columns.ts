import { Knex } from "knex";

/**
 * Drop the two-factor authentication columns.
 *
 * 2FA was removed from Dockge, but the columns stayed behind and an account
 * that still had twofa_status set could not log in and had no way to clear it.
 * Dropping them retires the flag along with the feature.
 *
 * SQLite cannot drop a column in place, so knex rebuilds the table for each
 * one - hence one statement per column rather than a single alterTable.
 * @param knex Knex instance
 */
export async function up(knex: Knex): Promise<void> {
    for (const column of [ "twofa_secret", "twofa_status", "twofa_last_token" ]) {
        if (await knex.schema.hasColumn("user", column)) {
            await knex.schema.table("user", (table) => {
                table.dropColumn(column);
            });
        }
    }
}

/**
 * Put the columns back, with the same definitions the user table was created
 * with. The stored secrets are gone for good; 2FA would have to be set up again.
 * @param knex Knex instance
 */
export async function down(knex: Knex): Promise<void> {
    await knex.schema.table("user", (table) => {
        table.string("twofa_secret", 64);
    });
    await knex.schema.table("user", (table) => {
        table.boolean("twofa_status").notNullable().defaultTo(false);
    });
    await knex.schema.table("user", (table) => {
        table.string("twofa_last_token", 6);
    });
}
