import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { serveGraderRequest, submitGraderRequest, type GraderBrokerRequest } from "../graderBroker"
import { createDefaultGraderRegistry } from "../../grading/index"
import { VirtualClock, ScriptedProcessRunner } from "../../testing/index"

let root: string
const request: GraderBrokerRequest = {
	schemaVersion: 1,
	attemptId: 7,
	workspaceRoot: "/workspace",
	changedPaths: [],
	trace: [],
	environment: {},
}
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-broker-contract-"))
})
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

describe("trusted grader broker receipts", () => {
	it("does not expose malformed receipt contents in diagnostics", async () => {
		await fs.writeFile(path.join(root, "response.json"), "secret-canary-invalid-json")
		await expect(submitGraderRequest(root, request, 1_000)).rejects.toThrow("Invalid trusted grader JSON envelope")
	})

	it("rejects oversized request evidence before invoking trusted grading", async () => {
		const file = path.join(root, "request.json")
		await fs.writeFile(file, "{}")
		await fs.truncate(file, 8 * 1024 * 1024 + 1)
		const execute = vi.fn()
		await expect(
			serveGraderRequest({ root, timeoutMs: 1_000, signal: new AbortController().signal, execute }),
		).rejects.toThrow("Invalid or oversized trusted grader envelope")
		expect(execute).not.toHaveBeenCalled()
	})

	it("refuses requests for a different attempt before invoking privileged grading", async () => {
		const controller = new AbortController()
		const execute = vi.fn(async () => ({ run: { decision: "passed" as const, results: [] }, artifacts: [] }))
		const server = serveGraderRequest({
			root,
			timeoutMs: 2_000,
			signal: controller.signal,
			expectedAttemptId: 8,
			execute,
		})
		try {
			await expect(submitGraderRequest(root, request, 2_000)).rejects.toThrow(/another attempt/)
			expect(execute).not.toHaveBeenCalled()
		} finally {
			controller.abort()
			await server
		}
	})
	it("rejects a stale response left by another request", async () => {
		await fs.writeFile(
			path.join(root, "response.json"),
			JSON.stringify({
				schemaVersion: 1,
				ok: true,
				requestId: "old-request",
				result: { run: { decision: "passed", results: [] }, artifacts: [] },
			}),
		)
		await expect(submitGraderRequest(root, request, 1_000)).rejects.toThrow(/request|receipt/i)
	})

	it("rejects a fresh claimed pass without grader evidence", async () => {
		const controller = new AbortController()
		const server = serveGraderRequest({
			root,
			timeoutMs: 2_000,
			signal: controller.signal,
			execute: async () => ({ run: { decision: "passed", results: [] }, artifacts: [] }),
		})
		try {
			await expect(submitGraderRequest(root, request, 2_000)).rejects.toThrow(/grader|receipt/i)
		} finally {
			controller.abort()
			await server
		}
	})

	it("accepts bound command evidence from the current request", async () => {
		const controller = new AbortController()
		const server = serveGraderRequest({
			root,
			timeoutMs: 2_000,
			signal: controller.signal,
			execute: async () => ({
				run: await createDefaultGraderRegistry().execute(
					[
						{
							id: "tests",
							version: 1,
							type: "command",
							hardGate: true,
							failureClass: "outcome",
							commands: [{ command: "test", args: [] }],
							cwd: "workspace",
							timeoutMs: 100,
							maxOutputBytes: 1024,
						},
					],
					{
						workspaceRoot: root,
						changedPaths: [],
						trace: [],
						clock: new VirtualClock(),
						processRunner: new ScriptedProcessRunner([
							{
								type: "result",
								result: {
									exitCode: 0,
									stdout: "passed",
									stderr: "",
									durationMs: 1,
									timedOut: false,
									outputTruncated: false,
								},
							},
						]),
					},
				),
				artifacts: [],
			}),
		})
		try {
			const receipt = await submitGraderRequest(root, request, 2_000)
			expect(receipt.run.decision).toBe("passed")
			expect(receipt.run.results[0]?.evidence).toHaveLength(2)
		} finally {
			controller.abort()
			await server
		}
	})
})
