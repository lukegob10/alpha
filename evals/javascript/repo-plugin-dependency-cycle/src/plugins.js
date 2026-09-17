export function loadPlugins(plugins) {
	const names = []
	for (const p of plugins) {
		for (const dep of p.requires ?? []) if (!names.includes(dep)) throw Error(`missing ${dep}`)
		names.push(p.name)
	}
	return names
}
