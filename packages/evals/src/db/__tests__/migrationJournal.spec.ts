import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
type LockedMigration = { idx: number; tag: string; when: number; sha256: string }

const migrationsRoot = new URL("../migrations/", import.meta.url)
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrationsRoot), "utf8")) as {
	version: string
	dialect: string
	entries: JournalEntry[]
}
const lock = JSON.parse(readFileSync(new URL("meta/released-migrations.lock.json", migrationsRoot), "utf8")) as {
	schemaVersion: number
	dialect: string
	migrations: LockedMigration[]
}

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex")

describe("released database migration history", () => {
	it("keeps shipped journal identities, timestamps, ordering, and SQL immutable", () => {
		expect(lock.schemaVersion).toBe(1)
		expect(journal.dialect).toBe(lock.dialect)
		expect(journal.entries.map((entry) => entry.idx)).toEqual(journal.entries.map((_, index) => index))
		for (let index = 1; index < journal.entries.length; index++)
			expect(journal.entries[index]!.when).toBeGreaterThan(journal.entries[index - 1]!.when)

		for (const migration of lock.migrations) {
			const entry = journal.entries[migration.idx]
			expect(entry).toMatchObject({
				idx: migration.idx,
				tag: migration.tag,
				when: migration.when,
				version: journal.version,
				breakpoints: true,
			})
			expect(sha256(readFileSync(new URL(`${migration.tag}.sql`, migrationsRoot)))).toBe(migration.sha256)
		}
	})
})
