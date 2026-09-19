/** Destructive test setup is limited to the dedicated local database, never URL substrings. */
export function assertIsolatedTestDatabase(value: string | undefined): void {
	let target: URL
	try {
		target = new URL(value ?? "")
	} catch {
		throw new Error("DATABASE_URL must identify the isolated local evals_test database")
	}
	if (
		!["postgres:", "postgresql:"].includes(target.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
		target.pathname !== "/evals_test" ||
		target.search !== "" ||
		target.hash !== ""
	)
		throw new Error("Destructive tests require the isolated local evals_test database without URL parameters")
}
