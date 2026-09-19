import path from "node:path"

export function pnpmInvocation(cliPath, args, node = process.execPath) {
	if (!cliPath || !path.isAbsolute(cliPath) || !/pnpm/i.test(path.basename(cliPath))) {
		throw new Error("Invoke through pnpm harness")
	}
	if (/\.(?:cmd|bat)$/i.test(cliPath)) throw new Error("Use a pnpm executable or JavaScript CLI, not a shell shim")
	return /\.(?:c?js|mjs)$/i.test(cliPath)
		? { executable: node, args: [cliPath, ...args] }
		: { executable: cliPath, args }
}
