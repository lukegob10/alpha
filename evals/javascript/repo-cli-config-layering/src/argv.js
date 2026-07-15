export function parseArgs(args) {
	const out = {}
	for (let i = 0; i < args.length; i += 2) out[args[i].replace(/^--/, "")] = args[i + 1]
	return out
}
