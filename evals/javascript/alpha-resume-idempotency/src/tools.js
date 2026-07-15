export async function invoke(store, call, execute) {
	const key = crypto.randomUUID()
	const value = await execute(call, key)
	store.set(call.id, { key, value })
	return value
}
