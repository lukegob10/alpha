import { writeFileSync } from "node:fs"

export function writeReport(report) {
	writeFileSync("reports.json", JSON.stringify(report))
}
