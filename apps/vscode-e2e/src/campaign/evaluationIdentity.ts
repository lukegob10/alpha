import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"

import { fingerprintArtifactPaths } from "./liveGate"
import { readBounded, rejectSymlinkComponents } from "../evidence/paths"
import type { CampaignConfig, CampaignEvaluationIdentity } from "./types"

const execute = promisify(execFile)
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

async function git(root: string, args: string[]): Promise<string> {
	return (await execute("git", args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout
}

/** Conservative source identity includes tracked and nonignored untracked inputs, never their contents in reports. */
async function sourceDigest(root: string, scopes: string[]): Promise<string> {
	const files = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes]))
		.split("\0")
		.filter(Boolean)
	const unique = [...new Set(files)].sort()
	if (!unique.length || unique.length > 20_000) throw new Error("Source identity file bound")
	const hash = createHash("sha256")
	let bytes = 0
	for (const file of unique) {
		const absolute = path.resolve(root, file)
		const relative = path.relative(root, absolute)
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Source outside repository")
		await rejectSymlinkComponents(absolute)
		hash.update(file + "\0")
		try {
			const size = (await lstat(absolute)).size
			if (size > 16 * 1024 * 1024) throw new Error("Source identity file bound")
			const value = await readBounded(absolute, size)
			bytes += value.length
			if (bytes > 128 * 1024 * 1024) throw new Error("Source identity byte bound")
			hash.update(digest(value) + "\0")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			hash.update("deleted\0")
		}
	}
	return hash.digest("hex")
}

export async function captureCampaignEvaluationIdentity(
	root: string,
	config: CampaignConfig,
): Promise<CampaignEvaluationIdentity> {
	const missing: string[] = []
	const capture = async (name: string, operation: () => Promise<string>) => {
		try {
			return await operation()
		} catch {
			missing.push(name)
			return null
		}
	}
	// Campaign IDs, profile locations and executable paths are operational labels, not experimental treatments.
	const configDigest = digest(
		JSON.stringify({
			hosts: config.hosts.map((host) => host.version),
			scenarioIds: config.scenarioIds,
			samples: config.samples,
			budgets: config.budgets,
			maxReproductions: config.maxReproductions,
		}),
	)
	const sourceComponentsDigest = await capture("sourceComponentsDigest", () =>
		sourceDigest(root, ["src", "packages", "webview-ui"]),
	)
	return {
		extensionCommit: await capture("extensionCommit", async () => (await git(root, ["rev-parse", "HEAD"])).trim()),
		workingTreeDigest: await capture("workingTreeDigest", () => sourceDigest(root, ["."])),
		extensionBuildDigest: await capture("extensionBuildDigest", () =>
			// Packaged externals, native bindings and WASM execute alongside extension.js.
			// A bundle-only digest cannot detect their replacement during a campaign.
			fingerprintArtifactPaths(root, ["src/package.json", "src/dist", "src/webview-ui/build"]),
		),
		harnessDigest: await capture("harnessDigest", () => fingerprintArtifactPaths(root, ["apps/vscode-e2e/out"])),
		taskSetDigest: await capture("taskSetDigest", () =>
			sourceDigest(root, [
				"apps/vscode-e2e/src/scenarios",
				"apps/vscode-e2e/src/suite",
				"apps/vscode-e2e/src/campaign/scenarios.ts",
				"apps/vscode-e2e/src/campaign/developmentSuites.ts",
			]),
		),
		sourceComponentsDigest,
		configDigest,
		unchanged: false,
		missing,
	}
}

export function finishCampaignEvaluationIdentity(
	before: CampaignEvaluationIdentity,
	after: CampaignEvaluationIdentity,
): CampaignEvaluationIdentity {
	const unchanged =
		before.missing.length === 0 &&
		after.missing.length === 0 &&
		Object.entries(before).every(
			([key, value]) =>
				key === "unchanged" || key === "missing" || value === after[key as keyof CampaignEvaluationIdentity],
		)
	return {
		...before,
		unchanged,
		missing: [
			...new Set([
				...before.missing,
				...after.missing,
				...(!unchanged && !before.missing.length && !after.missing.length
					? ["identity_changed_during_campaign"]
					: []),
			]),
		],
	}
}
