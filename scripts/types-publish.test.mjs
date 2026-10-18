import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { pnpmInvocation } from "./harness/pnpm.mjs"

const script = fileURLToPath(new URL("../packages/types/scripts/publish-npm.cjs", import.meta.url))
const source = readFileSync(script, "utf8")
const packageDirectory = path.dirname(path.dirname(script))
const npmDirectory = path.join(packageDirectory, "npm")

function publisher({ status = "", failStatus = false, failCommit = false } = {}) {
	const calls = []
	const writes = []
	const files = new Map([
		[path.join(packageDirectory, "package.json"), { dependencies: {} }],
		[path.join(npmDirectory, "package.metadata.json"), { name: "@alpha-code/types", version: "1.0.0" }],
	])
	const modules = {
		fs: {
			readFileSync: (file) => JSON.stringify(files.get(file)),
			writeFileSync: (file, contents) => {
				writes.push(file)
				files.set(file, JSON.parse(contents))
			},
		},
		path,
		child_process: {
			execFileSync: (executable, args, options) => {
				assert.ok(Array.isArray(args), "subprocess arguments must stay structured")
				assert.notEqual(options.shell, true)
				calls.push({ executable, args: [...args], options })
				if (executable === "git") {
					if (args[0] === "status") {
						if (failStatus) throw new Error("git status unavailable")
						return args.includes("--") ? " M npm/package.metadata.json\n" : status
					}
					if (args[0] === "rev-parse") return "main\n"
					if (args[0] === "commit" && failCommit) throw new Error("commit failed")
				} else if (executable === "gh") {
					throw new Error("GitHub CLI not available in the fixture")
				} else if (args.includes("version")) {
					files.get(path.join(npmDirectory, "package.json")).version = "1.1.0"
				}
				return ""
			},
		},
		readline: { createInterface: () => ({ question: (_text, answer) => answer("y"), close() {} }) },
		"../../../scripts/harness/pnpm.mjs": { pnpmInvocation },
	}
	const module = { exports: {} }
	const exit = (code) => {
		throw new Error(`fixture exit ${code}`)
	}
	vm.runInNewContext(
		source,
		{
			module,
			require: (name) => {
				assert.ok(name in modules, `unexpected module: ${name}`)
				return modules[name]
			},
			__dirname: path.dirname(script),
			process: {
				argv: [process.execPath, script],
				execPath: process.execPath,
				env: { npm_execpath: path.resolve("fixture pnpm", "pnpm.cjs") },
				exit,
			},
			console: { log() {}, warn() {}, error() {} },
		},
		{ filename: script },
	)
	return { ...module.exports, calls, writes }
}

for (const status of [" M ../../unrelated.ts\n", "M  ../../unrelated.ts\n", "?? ../../untracked.txt\n"]) {
	test(`publisher refuses ${JSON.stringify(status.trim())} before any file or package mutation`, async () => {
		const fixture = publisher({ status })
		await assert.rejects(fixture.publish(), /fixture exit 1/u)
		assert.deepEqual(fixture.writes, [])
		assert.equal(fixture.calls.length, 1)
		assert.deepEqual(fixture.calls[0].args, ["status", "--porcelain=v1", "--untracked-files=all"])
	})
}

test("publisher stops before mutation when Git cannot establish cleanliness", async () => {
	const fixture = publisher({ failStatus: true })
	await assert.rejects(fixture.publish(), /fixture exit 1/u)
	assert.deepEqual(fixture.writes, [])
	assert.equal(fixture.calls.length, 1)
})

test("publisher stages and commits only its tracked metadata, preserving unrelated staged work", () => {
	const fixture = publisher()
	fixture.commitVersionChanges("1.1.0")
	assert.deepEqual(
		fixture.calls.map((call) => call.args),
		[
			["status", "--porcelain=v1", "--", "npm/package.metadata.json"],
			["add", "--", "npm/package.metadata.json"],
			["commit", "--only", "-m", "chore: bump version to v1.1.0", "--", "npm/package.metadata.json"],
		],
	)
	assert.ok(fixture.calls.every((call) => call.options.cwd === packageDirectory))
})

test("publisher never pushes a branch after a failed version commit", () => {
	const fixture = publisher({ failCommit: true })
	assert.throws(() => fixture.createVersionBranchAndCommit("1.1.0"), /version branch could not be recorded/u)
	assert.equal(
		fixture.calls.some((call) => call.args[0] === "push"),
		false,
	)
})

test("publisher builds through the invoking pnpm with an explicit production environment", async () => {
	const fixture = publisher()
	await fixture.publish()
	assert.deepEqual(fixture.calls[0].args, ["status", "--porcelain=v1", "--untracked-files=all"])
	const build = fixture.calls.find((call) => call.args.includes("tsup"))
	assert.ok(build)
	assert.equal(build.executable, process.execPath)
	assert.deepEqual(build.args.slice(1), ["exec", "tsup", "--outDir", "npm/dist"])
	assert.equal(build.options.env.NODE_ENV, "production")
	const publish = fixture.calls.find((call) => call.args.includes("publish"))
	assert.deepEqual(publish.args.slice(1), ["publish", "--no-git-checks"])
})
