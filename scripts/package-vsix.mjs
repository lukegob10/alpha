#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { hostVsixTarget, lanceDbBindingForTarget, resolveLanceDbNativeDependencies } from "../src/lancedb-native.mjs"
import { validatePackageMetadata } from "./install-vsix.js"

const repository = fileURLToPath(new URL("../", import.meta.url))

export function packageVsix(argv = [], { root = repository, hostTarget = hostVsixTarget(), run = execFileSync } = {}) {
	let target = hostTarget
	if (argv.length > 0) {
		if (argv.length !== 2 || argv[0] !== "--target") {
			throw new Error("Usage: pnpm --dir src vsix [--target <platform>]")
		}
		target = argv[1]
	}
	lanceDbBindingForTarget(target)
	if (target !== hostTarget) {
		throw new Error(`Build VSIX target ${target} on a matching host; current host target is ${hostTarget}`)
	}

	const extensionDirectory = path.join(root, "src")
	const manifestPath = path.join(extensionDirectory, "package.json")
	const extensionRequire = createRequire(manifestPath)
	const { name, version } = validatePackageMetadata(JSON.parse(readFileSync(manifestPath, "utf8")))
	resolveLanceDbNativeDependencies(extensionRequire, target)
	const outputDirectory = path.join(root, "bin")
	const output = path.join(outputDirectory, `${name}-${version}-${target}.vsix`)
	mkdirSync(outputDirectory, { recursive: true })
	run(
		process.execPath,
		[
			extensionRequire.resolve("@vscode/vsce/vsce"),
			"package",
			"--no-dependencies",
			"--target",
			target,
			"--out",
			output,
		],
		{
			cwd: extensionDirectory,
			env: { ...process.env, ALPHA_VSIX_TARGET: target },
			stdio: "inherit",
			windowsHide: true,
		},
	)
	return output
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		packageVsix(process.argv.slice(2))
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
}
