#!/usr/bin/env node

import { spawnSync } from "child_process"

const REQUIRED_PNPM_VERSION = "11.24.0"

if (process.env.BOOTSTRAP_IN_PROGRESS) {
	console.log("⏭️  Bootstrap already in progress, continuing with normal installation...")
	process.exit(0)
}

const invokedByPnpmVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)pnpm\/([^\s]+)/)?.[1]
if (invokedByPnpmVersion === REQUIRED_PNPM_VERSION) {
	process.exit(0)
}

console.log(`🚀 Bootstrapping to pnpm@${REQUIRED_PNPM_VERSION}...`)

function getPnpmVersion() {
	const result = spawnSync("pnpm", ["--version"], {
		encoding: "utf8",
		shell: true,
	})

	if (result.status !== 0) {
		return undefined
	}

	return result.stdout.trim()
}

function runPnpmInstall(command, args) {
	return spawnSync(command, args, {
		stdio: "inherit",
		shell: true,
		env: {
			...process.env,
			BOOTSTRAP_IN_PROGRESS: "1",
		},
	})
}

try {
	const installedPnpmVersion = getPnpmVersion()

	if (installedPnpmVersion === REQUIRED_PNPM_VERSION) {
		console.log(`✨ Found pnpm@${REQUIRED_PNPM_VERSION}`)
		const pnpmInstall = runPnpmInstall("pnpm", ["install", "--frozen-lockfile"])

		if (pnpmInstall.status !== 0) {
			console.error("❌ pnpm install failed")
			process.exit(pnpmInstall.status ?? 1)
		}

		console.log("🎉 Bootstrap completed successfully!")
		process.exit(0)
	}

	if (installedPnpmVersion) {
		console.log(
			`⚠️  Found pnpm@${installedPnpmVersion}; using the required pnpm@${REQUIRED_PNPM_VERSION} instead...`,
		)
	} else {
		console.log("⚠️  Unable to find pnpm; fetching the required version temporarily...")
	}

	const pnpmInstall = runPnpmInstall("npm", [
		"exec",
		"--yes",
		`--package=pnpm@${REQUIRED_PNPM_VERSION}`,
		"--",
		"pnpm",
		"install",
		"--frozen-lockfile",
	])

	if (pnpmInstall.status !== 0) {
		console.error("❌ pnpm install failed")
		process.exit(pnpmInstall.status ?? 1)
	}

	console.log("🎉 Bootstrap completed successfully!")
	process.exit(0)
} catch (error) {
	console.error("💥 Bootstrap failed:", error.message)
	process.exit(1)
}
