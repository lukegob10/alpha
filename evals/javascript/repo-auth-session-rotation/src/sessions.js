export class Sessions {
	constructor() {
		this.active = new Map()
		this.used = new Set()
	}
	issue(user, token) {
		this.active.set(user, token)
	}
	rotate(user, oldToken, nextToken) {
		if (this.active.get(user) !== oldToken) return false
		this.active.set(user, nextToken)
		this.used.add(nextToken)
		return true
	}
}
