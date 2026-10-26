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
	it.each(["explore", "review", "worker"])("inherits parent authority independently of the %s role", (agentKind) => {
		const policy = { ...base.parentPolicy, network: true, externalSideEffects: true }
		const envelope = buildInternalTaskEnvelope({
			...base,
			parentPolicy: policy,
			agentKind,
			authorityModel: "parent",
		})
		expect(envelope.policy).toEqual(policy)
		expect(envelope.authorityModel).toBe("parent")
		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				agentKind,
				authorityModel: "parent",
				requestedPolicy: { network: true },
			}),
		).toThrow("cannot widen parent authority: network")
	})
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
