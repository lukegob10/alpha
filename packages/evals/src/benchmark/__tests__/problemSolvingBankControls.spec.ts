import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"
import { coreBankControls } from "../problemSolvingBankControls"

const evalRoot = path.resolve(process.cwd(), "../../evals")
const affectedControls = coreBankControls.filter(({ id }) =>
	["repo-stream-backpressure", "stateful-api-idempotency"].includes(id),
)
const incompleteControls: Record<string, string> = {
	"repo-stream-backpressure": `export async function exportRecords(records, write, { concurrency = 2, signal } = {}) {
	for (let index = 0; index < records.length; index += concurrency) {
		await Promise.all(records.slice(index, index + concurrency).map((record) => write(record, signal)))
	}
}
`,
	"stateful-api-idempotency": `export async function charge(store, provider, key, amount) {
	if (store.has(key)) return store.get(key)
	const result = await provider.charge(amount)
	store.set(key, result)
	return result
}
`,
}

async function removeControlWorkspace(root: string, parent: string): Promise<void> {
	const resolved = await fs.realpath(root)
	if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith("alpha-bank-obligations-"))
		throw new Error("Bank control cleanup ownership mismatch")
	await fs.rm(resolved, { recursive: true, force: true })
}

describe("problem-solving cancellation and idempotency controls", () => {
	for (const control of affectedControls) {
		it.each(["reference", "alternative", "broken", "incomplete"] as const)(
			`${control.id} grades %s`,
			async (kind) => {
				const parent = await fs.realpath(os.tmpdir())
				const root = await fs.mkdtemp(path.join(parent, "alpha-bank-obligations-"))
				try {
					await fs.cp(path.join(evalRoot, "javascript", control.id), root, { recursive: true })
					await fs.writeFile(
						path.join(root, control.target),
						kind === "incomplete" ? incompleteControls[control.id]! : control[kind],
					)
					const result = await new ExecaHarnessProcessRunner().run({
						command: process.execPath,
						args: ["--test", control.testFile],
						cwd: root,
						timeoutMs: 10_000,
						maxOutputBytes: 64_000,
					})
					expect(result.timedOut).toBe(false)
					if (kind === "reference" || kind === "alternative")
						expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
					else expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1)
				} finally {
					await removeControlWorkspace(root, parent)
				}
			},
		)
	}
})
