import { buildInternalTaskEnvelope, type BuildInternalTaskEnvelopeInput } from "../InternalTaskEnvelope"

const base: BuildInternalTaskEnvelopeInput = {
	parentTaskId: "root-1",
	rootTaskId: "root-1",
	depth: 1,
	objective: "Inspect nested orchestration",
	agentKind: "review",
	parentPolicy: {
		read: true,
		execute: false,
		mutate: false,
		delegate: true,
		network: false,
		externalSideEffects: false,
		requireApproval: false,
	},
	requestedPolicy: { read: true, delegate: true },
	workspaceRoots: ["F:/workspace"],
	budget: { maxDepth: 3, maxConcurrency: 2 },
}

describe("InternalTaskEnvelope nested ancestry", () => {
	it("preserves root-relative depth and narrowed delegation authority for descendants", () => {
		const child = buildInternalTaskEnvelope(base)
		const grandchild = buildInternalTaskEnvelope({
			...base,
			parentTaskId: child.id,
			depth: 2,
			agentKind: "explore",
		})

		expect(child).toMatchObject({ rootTaskId: "root-1", parentTaskId: "root-1", depth: 1 })
		expect(grandchild).toMatchObject({
			rootTaskId: "root-1",
			parentTaskId: child.id,
			depth: 2,
			policy: { read: true, execute: false, mutate: false, delegate: true },
			budget: { maxDepth: 3, maxConcurrency: 2 },
		})
	})

	it.each([
		[{ rootTaskId: undefined }, "both rootTaskId and depth"],
		[{ depth: undefined }, "both rootTaskId and depth"],
		[{ parentTaskId: "child-1", depth: 1 }, "parented directly"],
		[{ parentTaskId: "root-1", depth: 2 }, "parent below"],
		[{ parentTaskId: "child-1", depth: 4 }, "exceeds maximum depth 3"],
	] as const)("rejects invalid nested ancestry %j", (override, message) => {
		expect(() => buildInternalTaskEnvelope({ ...base, ...override })).toThrow(message)
	})

	it("rejects descendant delegation when the parent authority does not include it", () => {
		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				parentPolicy: { ...base.parentPolicy, delegate: false },
				requestedPolicy: { read: true, delegate: true },
			}),
		).toThrow("cannot widen parent authority: delegate")
	})
})
