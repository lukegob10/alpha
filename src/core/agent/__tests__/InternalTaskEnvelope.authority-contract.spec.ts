import { buildInternalTaskEnvelope, type BuildInternalTaskEnvelopeInput } from "../InternalTaskEnvelope"

const base: BuildInternalTaskEnvelopeInput = {
	parentTaskId: "parent",
	objective: "Inspect scope",
	parentPolicy: {
		read: true,
		execute: true,
		mutate: true,
		delegate: false,
		network: false,
		externalSideEffects: false,
		requireApproval: true,
	},
	requestedPolicy: {},
	workspaceRoots: ["F:/workspace"],
}

describe("InternalTaskEnvelope authority contract", () => {
	it.each(["toString", "constructor", "__proto__"])("rejects inherited route name %s", (modelRouteId) => {
		expect(() => buildInternalTaskEnvelope({ ...base, modelRouteId })).toThrow("Unknown model route")
	})

	it.each(["toString", "constructor", "__proto__"])("rejects inherited agent name %s", (agentKind) => {
		expect(() => buildInternalTaskEnvelope({ ...base, agentKind })).toThrow("Unknown agent kind")
	})

	it.each([{ parentAllowedPaths: [] }, { parentAllowedPaths: ["src/task.ts"] }])(
		"rejects writable scope omission under parent ceiling $parentAllowedPaths",
		({ parentAllowedPaths }) => {
			expect(() => buildInternalTaskEnvelope({ ...base, agentKind: "worker", parentAllowedPaths })).toThrow(
				"requires an explicit write scope",
			)
		},
	)

	it("permits broad read-only inspection and explicitly empty child write scope", () => {
		expect(
			buildInternalTaskEnvelope({ ...base, agentKind: "review", parentAllowedPaths: ["src"] }).policy.mutate,
		).toBe(false)
		expect(
			buildInternalTaskEnvelope({ ...base, agentKind: "worker", parentAllowedPaths: ["src"], allowedPaths: [] })
				.scope.allowedPaths,
		).toEqual([])
	})
})
