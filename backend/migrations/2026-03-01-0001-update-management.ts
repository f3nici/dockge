import { Knex } from "knex";

/**
 * Nothing to do: this is here so that a database carried over from
 * finder39/dockge can be migrated.
 *
 * That fork's database has this migration down as done. Knex refuses to run
 * any migration at all while one it has down as done is missing from the
 * folder, and Dockge carries on without them, so the update history and API
 * key tables of 2026-10-21 would never be set up on such a database. The
 * update_history table it created is picked up by
 * 2026-10-21-0000-update-history.
 * @param _knex Knex instance
 */
export async function up(_knex: Knex): Promise<void> {
}

/**
 * @param _knex Knex instance
 */
export async function down(_knex: Knex): Promise<void> {
}
