import { describe, expect, it } from "vitest"
import { assertIsolatedTestDatabase } from "../testDatabaseTarget"

describe("isolated destructive database target", () => {
	it.each(["localhost", "127.0.0.1", "[::1]"])("accepts dedicated database on %s", (host) => {
		expect(() => assertIsolatedTestDatabase(`postgres://user:password@${host}:5433/evals_test`)).not.toThrow()
	})
	it.each([
		undefined,
		"bad",
		"postgres://localhost:test@remote.example/prod",
		"postgres://localhost.evil/evals_test",
		"postgres://localhost/prod?test=1",
		"postgres://localhost/evals_test?host=remote",
		"postgres://localhost/evals_test_other",
		"https://localhost/evals_test",
	])("rejects unsafe target %s", (url) => {
		expect(() => assertIsolatedTestDatabase(url)).toThrow(/database/)
	})
})
