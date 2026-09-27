import { describe, expect, it } from "vitest"

import { toolApprovalDecisionSchema, toolApprovalRequestSchema } from "../tool-approval.js"

describe("tool approval contract", () => {
	it("validates the supported decision outcomes", () => {
		for (const decision of [
			{ decision: "approve_once" },
			{ decision: "approve_session" },
			{
				decision: "approve_persistently",
				amendment: { kind: "command_prefix", prefix: "git status --short" },
			},
			{ decision: "deny", feedback: "Please inspect the path first." },
			{ decision: "abort" },
			{ decision: "timeout" },
		]) {
			expect(toolApprovalDecisionSchema.parse(decision)).toEqual(decision)
		}
	})

	it("keeps session amendments exact and validates persistent command prefixes", () => {
		const amendment = {
			decision: "approve_with_amendment",
			amendment: { kind: "exact_command", command: "git status --short" },
		}
		expect(toolApprovalDecisionSchema.parse(amendment)).toEqual(amendment)
		expect(
			toolApprovalDecisionSchema.safeParse({
				decision: "approve_with_amendment",
				amendment: { kind: "command_prefix", prefix: "git" },
			}).success,
		).toBe(false)
		expect(
			toolApprovalDecisionSchema.safeParse({
				decision: "approve_persistently",
				amendment: { kind: "command_prefix", prefix: "git status && rm -rf ." },
			}).success,
		).toBe(false)
	})

	it("requires the reviewed request to advertise its exact session amendment", () => {
		const request = {
			requestId: "task-1:call-1",
			taskId: "task-1",
			callId: "call-1",
			toolName: "execute_command",
			askType: "command",
			description: "git status --short",
			cwd: "/workspace",
			forceApproval: false,
			requiresExplicitApproval: false,
			availableDecisions: ["approve_once", "approve_with_amendment", "deny", "abort"],
			proposedAmendment: { kind: "exact_command", command: "git status --short" },
		}

		expect(toolApprovalRequestSchema.parse(request)).toEqual(request)
		expect(toolApprovalRequestSchema.safeParse({ ...request, askType: "tool" }).success).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				proposedAmendment: { kind: "command_prefix", prefix: "git" },
			}).success,
		).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				requiresExplicitApproval: true,
			}).success,
		).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				availableDecisions: [...request.availableDecisions, "timeout"],
			}).success,
		).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				commandPathApproval: { outsidePaths: ["../outside.txt"], unresolved: false },
			}).success,
		).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				description: "git status --short && git push",
			}).success,
		).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				askType: "tool",
			}).success,
		).toBe(false)
	})

	it("requires a primary-safe persistent amendment to match the reviewed command", () => {
		const request = {
			requestId: "task-1:persistent-call",
			taskId: "task-1",
			callId: "persistent-call",
			toolName: "exec_command",
			askType: "command",
			description: "git status --short",
			cwd: "/workspace",
			forceApproval: false,
			requiresExplicitApproval: false,
			availableDecisions: ["approve_once", "approve_persistently", "deny", "abort"],
			proposedPersistentAmendment: { kind: "command_prefix", prefix: "git status --short" },
		}

		expect(toolApprovalRequestSchema.parse(request)).toEqual(request)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				commandPathApproval: { outsidePaths: ["../outside.txt"], unresolved: false },
			}).success,
		).toBe(false)
		expect(toolApprovalRequestSchema.safeParse({ ...request, requiresExplicitApproval: true }).success).toBe(false)
		expect(
			toolApprovalRequestSchema.safeParse({
				...request,
				proposedPersistentAmendment: { kind: "command_prefix", prefix: "git status" },
			}).success,
		).toBe(false)
	})
})
