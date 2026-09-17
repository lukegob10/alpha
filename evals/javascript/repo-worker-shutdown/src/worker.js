export class Worker {
	constructor(run) {
		this.run = run
		this.pending = []
	}
	submit(job) {
		const p = this.run(job)
		this.pending.push(p)
		return p
	}
	async close() {
		this.pending = []
	}
}
