import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { acquireProfileLease, assertRunnerAncestry } from "../hostOwnership"

test("accepts only an extension host descended from the campaign runner", async () => {
	const parents = async () =>
		new Map([
			[40, 30],
			[30, 20],
			[20, 10],
		])
	await assertRunnerAncestry(10, 40, parents)
	await assert.rejects(assertRunnerAncestry(50, 40, parents), /not owned/)
	await assert.rejects(assertRunnerAncestry(40, 40, parents), /Invalid/)
	await assert.rejects(assertRunnerAncestry(Number.NaN, 40, parents), /Invalid/)
})

test("does not accept incomplete or cyclic ancestry and propagates unavailable inspection", async () => {
	await assert.rejects(
		assertRunnerAncestry(
			10,
			40,
			async () =>
				new Map([
					[40, 30],
					[30, 40],
				]),
		),
		/not owned/,
	)
	await assert.rejects(
		assertRunnerAncestry(10, 40, async () => new Map()),
		/not owned/,
	)
	await assert.rejects(
		assertRunnerAncestry(10, 40, async () => {
			throw new Error("unavailable")
		}),
		/unavailable/,
	)
})

test("profile launch lease serializes runners and releases only its own token", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-e2e-lease-test-"))
	try {
		const userData = path.join(root, "user-data")
		await fs.mkdir(userData)
		const release = await acquireProfileLease(userData)
		await assert.rejects(acquireProfileLease(userData), { code: "profile-busy" })
		await release()
		const secondRelease = await acquireProfileLease(userData)
		const leasePath = path.join(root, ".alpha-e2e-launch.json")
		await fs.writeFile(leasePath, "foreign owner")
		await assert.rejects(secondRelease(), /ownership was lost/)
		assert.equal(await fs.readFile(leasePath, "utf8"), "foreign owner")
		assert.deepEqual((await fs.readdir(root)).sort(), [".alpha-e2e-launch.json", "user-data"])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("an empty or crashed launch lease is retained rather than stolen by age", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-e2e-lease-test-"))
	try {
		await fs.writeFile(path.join(root, ".alpha-e2e-launch.json"), "")
		await assert.rejects(acquireProfileLease(path.join(root, "user-data")), { code: "profile-busy" })
		assert.equal(await fs.readFile(path.join(root, ".alpha-e2e-launch.json"), "utf8"), "")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
