export function buildOrder(packages) {
	return packages.map((p) => p.name).sort()
}
