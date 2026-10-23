import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const script = fileURLToPath(new URL("./certification/managed-agent-milestone-certify.mjs", import.meta.url))

test("managed-agent certification discovers its public lifecycle regression suites exactly once", () => {
	const result = spawnSync(process.execPath, [script, "--list"], {
		cwd: root,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	})
	assert.equal(result.error, undefined)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /^types-build :: pnpm --filter @alpha-code\/types build$/m)
	assert.equal(
		/live-preflight|live-playbook-preflight|prepare-run-c/.test(result.stdout),
		false,
		"Automated certification must not depend on retired live prompts or their fixture preparer",
	)
	const commands = result.stdout.split(/\r?\n/).filter((line) => line.includes(" :: pnpm --dir "))
	for (const file of [
		"core/webview/__tests__/AlphaProvider.managed-owned-disposal.spec.ts",
		"core/webview/__tests__/AlphaProvider.managed-lifecycle-convergence.spec.ts",
		"core/webview/__tests__/AlphaProvider.managed-automatic-cold-followup.spec.ts",
		"core/task/__tests__/Task.managed-unload-ownership-public.spec.ts",
		"core/task/__tests__/Task.managed-unload-output-public.spec.ts",
		"core/task/__tests__/Task.managed-runtime-residency.spec.ts",
		"core/task/__tests__/Task.managed-peer-discovery.spec.ts",
	]) {
		const owners = commands.filter((line) => line.split(/\s+/).includes(file))
		assert.equal(owners.length, 1, `${file} must be selected by exactly one certification track`)
		assert.ok(
			owners[0].startsWith("lifecycle-routing :: pnpm --dir src "),
			`${file} must retain its lifecycle owner`,
		)
	}
})
