import { sql } from "drizzle-orm"

import { testDb, disconnect } from "./src/db/db.js"

async function resetTestDatabase() {
	const db = testDb

	if (!db) {
		console.log("No database connection available, skipping database reset")
		return
	}

	try {
		const tables = await db.execute<{ table_name: string }>(sql`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
			AND table_type = 'BASE TABLE';
		`)

		const tableNames = tables.map((t) => t.table_name)

		for (const tableName of tableNames) {
			await db.execute(sql`TRUNCATE TABLE "${sql.raw(tableName)}" CASCADE;`)
		}

		console.log(`Reset isolated evaluator test database (${tableNames.length} tables)`)
	} catch {
		// Vitest prints thrown errors, including driver messages that may contain connection details.
		throw new Error("Unable to reset isolated evaluator test database; check service readiness and migrations")
	}
}

export default async function () {
	await resetTestDatabase()

	return async () => {
		await disconnect()
	}
}
