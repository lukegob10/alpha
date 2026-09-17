export async function migrate(store, steps) {
	for (const step of steps) await step.up(store)
	store.version++
	return store
}
