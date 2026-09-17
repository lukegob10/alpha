export class ConfigCache {
	#raw = new Map()
	#derived = new Map()
	set(key, value) {
		this.#raw.set(key, value)
		this.#derived.delete(key)
	}
	getPort() {
		if (!this.#derived.has("port")) this.#derived.set("port", Number(this.#raw.get("port") ?? 80))
		return this.#derived.get("port")
	}
	getOrigin() {
		if (!this.#derived.has("origin")) this.#derived.set("origin", `http://localhost:${this.getPort()}`)
		return this.#derived.get("origin")
	}
}
