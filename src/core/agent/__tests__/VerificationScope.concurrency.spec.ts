import path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { execute, realpath } = vi.hoisted(() => ({ execute: vi.fn(), realpath: vi.fn() }))

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process")
	const { promisify } = await import("util")
	const execFile = Object.assign(vi.fn(), { [promisify.custom]: execute })
	return { ...actual, execFile }
})

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, default: { ...actual, realpath } }
})

import { captureGitMutationState } from "../VerificationScope"

type Observation = {
	args: string[]
	resolve(stdout: string): void
	reject(error: Error): void
}

describe("Git mutation observation scheduling", () => {
	const root = path.resolve("verification-workspace")
	const head = "a".repeat(40)
	let observations: Observation[]
	let admitted: Array<() => void>

	const nextObservation = async (index: number) => {
		if (!observations[index]) await new Promise<void>((resolve) => (admitted[index] = resolve))
		return observations[index]
	}
	const flush = async () => {
		for (let index = 0; index < 10; index++) await Promise.resolve()
	}
	const capture = () => {
		let settled = false
		const result = captureGitMutationState(root).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		)
		void result.then(() => (settled = true))
		return { result, settled: () => settled }
	}

	beforeEach(() => {
		observations = []
		admitted = []
		realpath.mockReset().mockImplementation(async (value: string) => value)
		execute.mockReset().mockImplementation((_file: string, args: string[]) => {
			return new Promise<{ stdout: string }>((resolve, reject) => {
				observations.push({ args, resolve: (stdout) => resolve({ stdout }), reject })
				admitted[observations.length - 1]?.()
			})
		})
	})

	it("overlaps independent reads while retaining opening and closing HEAD fences", async () => {
		const operation = capture()
		await nextObservation(0)
		expect(observations.map(({ args }) => args.at(-1))).toEqual(["--show-toplevel", "HEAD"])
		observations[0].resolve(root)
		await flush()
		expect(observations).toHaveLength(2)
		observations[1].resolve(head)
		await nextObservation(2)
		expect(observations).toHaveLength(4)
		expect(observations[2].args).toContain("status")
		expect(observations[3].args).toContain("ls-files")
		observations[2].resolve("")
		await flush()
		expect(observations).toHaveLength(4)
		observations[3].resolve("")
		const closingHead = await nextObservation(4)
		expect(closingHead.args.at(-1)).toBe("HEAD")
		expect(operation.settled()).toBe(false)
		closingHead.resolve(head)
		expect(await operation.result).toMatchObject({ value: { head, files: {} } })
	})

	it.each(["opening", "inventory"] as const)(
		"drains a failed %s pair before returning its first error",
		async (phase) => {
			const operation = capture()
			await nextObservation(0)
			expect(observations).toHaveLength(2)
			if (phase === "inventory") {
				observations[0].resolve(root)
				observations[1].resolve(head)
				await nextObservation(2)
				expect(observations).toHaveLength(4)
			}
			const first = observations.at(-2)!
			const sibling = observations.at(-1)!
			const failure = new Error("First observation failed")
			first.reject(failure)
			await flush()
			expect(operation.settled()).toBe(false)
			sibling.reject(new Error("Sibling failed later"))
			expect(await operation.result).toEqual({ error: failure })
			expect(observations).toHaveLength(phase === "opening" ? 2 : 4)
		},
	)

	it("rejects a different repository root before inventory reads", async () => {
		const operation = capture()
		await nextObservation(0)
		expect(observations).toHaveLength(2)
		observations[0].resolve(path.dirname(root))
		observations[1].reject(new Error("HEAD unavailable"))
		expect(await operation.result).toMatchObject({
			error: {
				name: "VerificationScopeError",
				message: "Git observation requires the workspace repository root",
			},
		})
		expect(observations).toHaveLength(2)
	})

	it("rejects a changed HEAD after both inventory reads", async () => {
		const operation = capture()
		await nextObservation(0)
		expect(observations).toHaveLength(2)
		observations[0].resolve(root)
		observations[1].resolve(head)
		await nextObservation(2)
		expect(observations).toHaveLength(4)
		observations[2].resolve("")
		observations[3].resolve("")
		const closingHead = await nextObservation(4)
		closingHead.resolve("b".repeat(40))
		expect(await operation.result).toMatchObject({
			error: { name: "VerificationScopeError", message: "Git HEAD changed while observing changes" },
		})
	})
})
