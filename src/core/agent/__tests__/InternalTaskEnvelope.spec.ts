import path from "path"

import {
	buildInternalTaskEnvelope,
	isValidInternalTaskEnvelope,
	serializeInternalTaskEnvelope,
	type InternalTaskPolicy,
} from "../InternalTaskEnvelope"

const full: InternalTaskPolicy = {
	read: true,
	execute: true,
	mutate: true,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: true,
}
const base = {
	parentTaskId: "parent",
	objective: "Inspect failures",
	parentPolicy: full,
	requestedPolicy: {},
	workspaceRoots: ["F:/workspace"],
	id: "child",
}

describe("internal task envelopes", () => {
	it("builds deterministic diagnostic, implementation, and verification policies", () => {
		const diagnostic = buildInternalTaskEnvelope({
			...base,
			requestedPolicy: { mutate: false },
			agentKind: "explore",
		})
		const implementation = buildInternalTaskEnvelope({
			...base,
			requestedPolicy: { network: false, externalSideEffects: false },
			allowedPaths: ["F:/workspace/src"],
		})
		const verification = buildInternalTaskEnvelope({
			...base,
			requestedPolicy: { mutate: false },
			objective: "Run bounded checks",
		})
		expect(diagnostic.policy).toMatchObject({
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
		})
		expect(implementation.policy).toMatchObject({ mutate: true, externalSideEffects: false })
		expect(verification.policy).toMatchObject({ execute: true, mutate: false })
		expect(buildInternalTaskEnvelope({ ...base, requestedPolicy: {}, modelRouteId: "fast" }).policy).toEqual(
			buildInternalTaskEnvelope({ ...base, requestedPolicy: {}, modelRouteId: "deep" }).policy,
		)
	})

	it("resolves skills by id and records only identifiers and digests", () => {
		const envelope = buildInternalTaskEnvelope({
			...base,
			skillIds: ["typescript"],
			availableSkills: [{ id: "typescript", content: "apiKey=secret instructions" }],
		})
		expect(envelope.skills[0]).toMatchObject({ id: "typescript", digest: expect.any(String) })
		expect(serializeInternalTaskEnvelope(envelope)).not.toContain("secret instructions")
	})

	it.each([
		["agent kind", { agentKind: "unknown" }],
		["route", { modelRouteId: "unknown" }],
		["skill", { skillIds: ["missing"] }],
		["scope", { allowedPaths: ["F:/outside"] }],
	])("fails closed for unknown or invalid %s", (_label, override) => {
		expect(() => buildInternalTaskEnvelope({ ...base, ...override } as any)).toThrow()
	})

	it("rejects authority widening", () => {
		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				parentPolicy: { ...full, mutate: false },
				requestedPolicy: { mutate: true },
			}),
		).toThrow("widen")
	})

	it.each(["explore", "review"] as const)("never grants execute, mutate, or delegation authority to %s", (role) => {
		const envelope = buildInternalTaskEnvelope({
			...base,
			agentKind: role,
			requestedPolicy: { read: true, execute: false, mutate: false, delegate: false },
		})
		expect(envelope.policy).toMatchObject({ read: true, execute: false, mutate: false, delegate: false })
		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				parentPolicy: { ...full, delegate: true },
				agentKind: role,
				requestedPolicy: { execute: true },
			}),
		).toThrow(`${role} role`)
	})

	it("intersects Worker authority with parent roots and exact write scope", () => {
		const worker = buildInternalTaskEnvelope({
			...base,
			agentKind: "worker",
			requestedPolicy: { read: true, execute: true, mutate: true, delegate: false },
			parentWorkspaceRoots: ["F:/workspace"],
			parentAllowedPaths: ["src", "package.json"],
			parentFileAllowedPaths: ["package.json"],
			allowedPaths: ["src/task", "package.json"],
		})
		expect(worker.policy).toMatchObject({ execute: true, mutate: true, delegate: false })
		expect(worker.scope.allowedPaths).toEqual(
			[path.resolve("F:/workspace/package.json"), path.resolve("F:/workspace/src/task")].sort(),
		)

		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				agentKind: "worker",
				requestedPolicy: { execute: true, mutate: true },
				parentWorkspaceRoots: ["F:/workspace"],
				parentAllowedPaths: ["package.json"],
				parentFileAllowedPaths: ["package.json"],
				allowedPaths: ["package.json/generated"],
			}),
		).toThrow("write scope")
		expect(() =>
			buildInternalTaskEnvelope({
				...base,
				agentKind: "worker",
				requestedPolicy: { execute: true, mutate: true },
				workspaceRoots: ["F:/outside"],
				parentWorkspaceRoots: ["F:/workspace"],
			}),
		).toThrow("workspace root")
	})

	it("detects envelope tampering", () => {
		const envelope = buildInternalTaskEnvelope(base)
		expect(isValidInternalTaskEnvelope(envelope)).toBe(true)
		expect(isValidInternalTaskEnvelope({ ...envelope, objective: "tampered" })).toBe(false)
	})
})
