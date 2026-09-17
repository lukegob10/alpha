import fs from "fs/promises"
import os from "os"
import path from "path"
import { taskWorkPlanSchema, historyItemSchema, type TaskWorkPlan } from "@alpha-code/types"
import { digestValue } from "../StepContext"
import {
	captureAcceptanceChecks,
	settleAcceptanceChecks,
	getOutstandingAcceptanceChecks,
	replaceWorkPlan,
	restoreWorkContext,
	formatWorkContext,
} from "../TaskWorkContext"

describe("task acceptance evidence", () => {
	let root: string
	let plan: TaskWorkPlan
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-acceptance-"))
		await fs.writeFile(path.join(root, "app.py"), "print('working')")
		await fs.writeFile(path.join(root, "config.json"), "{}")
		plan = {
			objective: "Create the program",
			constraints: ["Preserve input files"],
			notes: [],
			checks: [
				{
					id: "behavior",
					description: "Run representative input",
					command: "python app.py",
					cwd: null,
					paths: ["app.py", "config.json"],
					reusable: true,
				},
			],
		}
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
	})
	async function run(succeeded = true) {
		const context = replaceWorkPlan(undefined, plan)
		const captured = await captureAcceptanceChecks(context, root, "python app.py", root, "execution")
		return settleAcceptanceChecks(context, root, captured, succeeded, succeeded ? 0 : 1)
	}
	it("reuses observed success across reload without another execution", async () => {
		const restored = restoreWorkContext(await run())
		expect(await getOutstandingAcceptanceChecks(restored, root)).toEqual([])
		expect(await getOutstandingAcceptanceChecks(restored, root)).toEqual([])
		expect(formatWorkContext(restored)).toContain("Preserve input files")
	})
	it("keeps failure explicit and a later successful repair replaces it", async () => {
		const failed = await run(false)
		expect(await getOutstandingAcceptanceChecks(failed, root)).toEqual(["behavior: failed"])
		const captured = await captureAcceptanceChecks(failed, root, "python app.py", root, "repair")
		const repaired = await settleAcceptanceChecks({ ...failed, receipts: captured }, root, captured, true, 0)
		expect(await getOutstandingAcceptanceChecks(repaired, root)).toEqual([])
		expect(repaired.receipts).toHaveLength(1)
	})
	it.each([true, false])(
		"preserves observed evidence through descriptive plan updates (passed=%s)",
		async (passed) => {
			const context = await run(passed)
			const replacement = structuredClone(plan)
			replacement.checks[0].description = "Verify the finished program"
			replacement.checks[0].paths.reverse()
			replacement.checks[0].cwd = "."
			const updated = restoreWorkContext(replaceWorkPlan(context, replacement))
			expect(updated.receipts).toHaveLength(1)
			expect(updated.receipts[0].status).toBe(passed ? "passed" : "failed")
			expect(await getOutstandingAcceptanceChecks(updated, root)).toEqual(passed ? [] : ["behavior: failed"])
		},
	)
	it("settles a running check after its description and input order change", async () => {
		const context = replaceWorkPlan(undefined, plan)
		const captured = await captureAcceptanceChecks(context, root, "python app.py", root, "running")
		context.receipts = captured
		const replacement = structuredClone(plan)
		replacement.checks[0].description = "Verify the finished program"
		replacement.checks[0].paths.reverse()
		const updated = replaceWorkPlan(context, replacement)
		const settled = await settleAcceptanceChecks(updated, root, captured, true, 0)
		expect(await getOutstandingAcceptanceChecks(settled, root)).toEqual([])
		expect(settled.receipts[0]).toMatchObject({ executionId: "running", status: "passed" })
	})
	it("preserves legacy receipt evidence when the plan is reworded after reload", async () => {
		const context = await run()
		context.receipts[0].definitionDigest = digestValue(plan.checks[0])
		const restored = restoreWorkContext(context)
		expect(await getOutstandingAcceptanceChecks(restored, root)).toEqual([])
		const replacement = structuredClone(plan)
		replacement.checks[0].description = "A clearer label for the same check"
		expect(await getOutstandingAcceptanceChecks(replaceWorkPlan(restored, replacement), root)).toEqual([])
	})
	it.each(["command", "cwd", "paths", "reusable"] as const)("invalidates evidence when %s changes", async (field) => {
		const context = await run()
		const replacement = structuredClone(plan)
		const check = replacement.checks[0]
		if (field === "command") check.command = "python other.py"
		if (field === "cwd") check.cwd = "subdirectory"
		if (field === "paths") check.paths.push("other.py")
		if (field === "reusable") check.reusable = false
		const updated = replaceWorkPlan(context, replacement)
		expect(updated.receipts).toEqual([])
		expect(await getOutstandingAcceptanceChecks(updated, root)).toEqual(["behavior: not run"])
	})
	it.each(["app.py", "config.json"])("invalidates a later change to %s", async (file) => {
		const context = await run()
		await fs.writeFile(path.join(root, file), "changed")
		expect(await getOutstandingAcceptanceChecks(context, root)).toEqual(["behavior: inputs changed"])
	})
	it("does not invalidate evidence for an unrelated edit", async () => {
		const context = await run()
		await fs.writeFile(path.join(root, "notes.txt"), "unrelated")
		expect(await getOutstandingAcceptanceChecks(context, root)).toEqual([])
	})
	it("rejects credit when a command changes its declared inputs", async () => {
		const context = replaceWorkPlan(undefined, plan)
		const captured = await captureAcceptanceChecks(context, root, "python app.py", root, "changing")
		await fs.writeFile(path.join(root, "app.py"), "changed during check")
		const settled = await settleAcceptanceChecks(context, root, captured, true, 0)
		expect(await getOutstandingAcceptanceChecks(settled, root)).toEqual(["behavior: stale"])
	})
	it("requires the exact declared command and directory", async () => {
		const context = replaceWorkPlan(undefined, plan)
		expect(await captureAcceptanceChecks(context, root, "echo pass", root, "wrong")).toEqual([])
		expect(await captureAcceptanceChecks(context, root, "python app.py", path.dirname(root), "wrong")).toEqual([])
		expect(await getOutstandingAcceptanceChecks(context, root)).toEqual(["behavior: not run"])
	})
	it("does not grant evidence to outside paths or unavailable content", async () => {
		plan.checks[0].paths = ["../outside"]
		const context = await run()
		expect(await getOutstandingAcceptanceChecks(context, root)).toEqual(["behavior: unavailable"])
	})
	it("respects ignored inputs both during admission and when reusing old evidence", async () => {
		const context = await run()
		expect(await getOutstandingAcceptanceChecks(context, root, () => false)).toEqual([
			"behavior: inputs unavailable",
		])
		const captured = await captureAcceptanceChecks(context, root, "python app.py", root, "ignored", () => false)
		expect(captured[0].status).toBe("unavailable")
		expect(captured[0].files).toBeUndefined()
	})
	it("does not revive a live check invalidated by a newer request", async () => {
		plan.checks[0].reusable = false
		const context = replaceWorkPlan(undefined, plan)
		const captured = await captureAcceptanceChecks(context, root, "python app.py", root, "old-request")
		context.receipts = captured
		const nextRequest = restoreWorkContext(context)
		const settled = await settleAcceptanceChecks(nextRequest, root, captured, true, 0)
		expect(settled.receipts[0].status).toBe("stale")
	})
	it("retains a newer command receipt when an older command settles late", async () => {
		const context = replaceWorkPlan(undefined, plan)
		const older = await captureAcceptanceChecks(context, root, "python app.py", root, "older")
		context.receipts = await captureAcceptanceChecks(context, root, "python app.py", root, "newer")
		const settled = await settleAcceptanceChecks(context, root, older, true, 0)
		expect(settled.receipts[0]).toMatchObject({ executionId: "newer", status: "running" })
	})
	it("invalidates changed check definitions and interrupted or live checks on resume", async () => {
		const context = await run()
		const replacement = structuredClone(plan)
		replacement.checks[0].command = "python other.py"
		expect(replaceWorkPlan(context, replacement).receipts).toEqual([])
		context.plan!.checks[0].reusable = false
		expect(restoreWorkContext(context).receipts[0].status).toBe("stale")
		context.receipts[0].status = "running"
		expect(restoreWorkContext(context).receipts[0].status).toBe("stale")
	})
	it("validates persisted context and rejects duplicate or oversized plans", () => {
		expect(taskWorkPlanSchema.safeParse({ ...plan, checks: [plan.checks[0], plan.checks[0]] }).success).toBe(false)
		expect(taskWorkPlanSchema.safeParse({ ...plan, notes: Array(16).fill("x".repeat(2000)) }).success).toBe(false)
		const history = { id: "task", number: 1, ts: 0, task: "Task", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		expect(historyItemSchema.parse(history).workContext).toBeUndefined()
		expect(
			historyItemSchema.parse({ ...history, workContext: replaceWorkPlan(undefined, plan) }).workContext?.plan,
		).toEqual(plan)
	})
})
