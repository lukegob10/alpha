export function effectiveRules(layers) {
	return Object.assign({}, ...layers.toReversed())
}
export function mayEdit(file, rules) {
	return !(rules.protected ?? []).includes(file)
}
