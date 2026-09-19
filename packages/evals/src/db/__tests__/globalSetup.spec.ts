import { expect, it, vi } from "vitest"
vi.mock("../db.js", () => ({
	testDb: { execute: vi.fn().mockRejectedValue(new Error("postgres://user:secret@localhost/evals_test")) },
	disconnect: vi.fn(),
}))
import setup from "../../../vitest-global-setup"

it("does not expose raw database connection failures through Vitest setup", async () => {
	const error = await setup().catch((failure: Error) => failure)
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({
		message: "Unable to reset isolated evaluator test database; check service readiness and migrations",
	})
	expect(error).not.toHaveProperty("cause")
})
