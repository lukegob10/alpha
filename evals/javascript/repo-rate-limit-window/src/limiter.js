export class Limiter {
	constructor(limit, windowMs) {
		this.limit = limit
		this.windowMs = windowMs
		this.hits = []
	}
	allow(now) {
		this.hits = this.hits.filter((t) => now - t <= this.windowMs)
		this.hits.push(now)
		return this.hits.length <= this.limit
	}
}
