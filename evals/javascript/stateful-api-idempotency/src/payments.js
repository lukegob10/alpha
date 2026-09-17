export async function charge(store, provider, key, amount) {
	const result = await provider.charge(amount)
	store.set(key, result)
	return result
}
