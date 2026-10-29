import { agentCanonicalPathSchema, resolveAgentPathReference } from "../agent-control.js"

describe("managed agent path compatibility", () => {
	it.each(["/root", "/root/code_review", "/root/old-name/code_review-2"])("reads persisted path %s", (path) => {
		expect(agentCanonicalPathSchema.parse(path)).toBe(path)
	})

	it("resolves nested caller-relative references without changing canonical identity", () => {
		expect(resolveAgentPathReference("/root/backend_api", "worker/code_review")).toBe(
			"/root/backend_api/worker/code_review",
		)
		expect(resolveAgentPathReference("/root/backend_api", "/root/frontend")).toBe("/root/frontend")
	})

	it.each(["../other", "worker/../other", "worker//other", "worker/", "worker\\other", "/other"])(
		"rejects malformed reference %s",
		(reference) => expect(() => resolveAgentPathReference("/root", reference)).toThrow(),
	)
})
