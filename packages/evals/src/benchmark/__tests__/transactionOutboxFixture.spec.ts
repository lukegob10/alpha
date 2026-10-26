import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"

const fixture = path.resolve(process.cwd(), "../../evals/javascript/repo-transaction-outbox-v2")
const events = `export function orderCreatedEvent(order) {
	return { id: "order:" + order.id, type: "order.created", payload: order }
}
`
const orders = `import { orderCreatedEvent } from "./events.js"
export async function createOrder(db, order) {
	return db.transaction(async (tx) => {
		await tx.insertOrder(order)
		await tx.insertOutbox(orderCreatedEvent(order))
	})
}
`

describe("versioned transaction outbox workload", () => {
	it("requires both modules and awaited atomic writes while accepting a different implementation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-outbox-v2-"))
		const runner = new ExecaHarnessProcessRunner()
		try {
			const variants = [
				{ id: "untouched", patch: {}, passes: false },
				{ id: "orders-only", patch: { "orders.js": orders }, passes: false },
				{ id: "events-only", patch: { "events.js": events }, passes: false },
				{
					id: "unawaited-event",
					patch: {
						"orders.js": orders.replace("await tx.insertOutbox", "tx.insertOutbox"),
						"events.js": events,
					},
					passes: false,
				},
				{ id: "reference", patch: { "orders.js": orders, "events.js": events }, passes: true },
				{
					id: "alternative",
					patch: {
						"orders.js": `import { orderCreatedEvent } from "./events.js"
export const createOrder = (db, order) => db.transaction((tx) =>
	tx.insertOrder(order).then(() => tx.insertOutbox(orderCreatedEvent(order))))
`,
						"events.js": `export const orderCreatedEvent = (payload) => ({
	id: ["order", payload.id].join(":"), type: "order.created", payload,
})
`,
					},
					passes: true,
				},
			]
			for (const variant of variants) {
				const workspace = path.join(root, variant.id)
				await fs.cp(fixture, workspace, { recursive: true })
				for (const [file, contents] of Object.entries(variant.patch))
					await fs.writeFile(path.join(workspace, "src", file), contents)
				const result = await runner.run({
					command: "node",
					args: ["--test", "--test-reporter=tap", "test/behavior.test.js"],
					cwd: workspace,
					timeoutMs: 15_000,
					maxOutputBytes: 64_000,
				})
				expect(result.timedOut, variant.id).toBe(false)
				expect(result.exitCode, `${variant.id}: ${result.stdout}\n${result.stderr}`).toBe(
					variant.passes ? 0 : 1,
				)
				if (variant.passes) expect(result.stdout).toMatch(/# pass 4\b/)
				else {
					expect(result.stdout + result.stderr).toContain("ERR_ASSERTION")
					expect(result.stdout + result.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND/)
				}
			}
		} finally {
			await removeOwnedTemporaryRoot(root)
		}
	})
})

async function removeOwnedTemporaryRoot(root: string): Promise<void> {
	const relative = path.relative(os.tmpdir(), path.resolve(root))
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("Refusing cleanup outside the owned temporary directory")
	await fs.rm(root, {
		recursive: true,
		force: true,
		maxRetries: process.platform === "win32" ? 3 : 0,
		retryDelay: 100,
	})
}
