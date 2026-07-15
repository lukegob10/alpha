export class Lock {
	constructor(now = () => Date.now()) {
		this.now = now
		this.owner = null
	}
	acquire(token, ttl) {
		this.owner = { token, expires: this.now() + ttl }
		return true
	}
	release() {
		this.owner = null
		return true
	}
}
