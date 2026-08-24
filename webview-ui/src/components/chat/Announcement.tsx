import { memo, useState } from "react"

import { Package } from "@alpha/package"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@src/components/ui"

interface AnnouncementProps {
	hideAnnouncement: () => void
}

/**
 * You must update the `latestAnnouncementId` in ClineProvider for new
 * announcements to show to users. This new id will be compared with what's in
 * state for the 'last announcement shown', and if it's different then the
 * announcement will render. As soon as an announcement is shown, the id will be
 * updated in state. This ensures that announcements are not shown more than
 * once, even if the user doesn't close it themselves.
 */

const Announcement = ({ hideAnnouncement }: AnnouncementProps) => {
	const [open, setOpen] = useState(true)

	return (
		<Dialog
			open={open}
			onOpenChange={(open) => {
				setOpen(open)

				if (!open) {
					hideAnnouncement()
				}
			}}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Welcome to Alpha v{Package.version}</DialogTitle>
				</DialogHeader>
				<div className="space-y-2 text-sm">
					<p>
						Alpha v{Package.version} keeps the primary agent focused while managed subagents run bounded
						work in parallel and return durable results.
					</p>
					<ul className="list-disc space-y-1 pl-5">
						<li>Blocking handoffs and background delegation now have clear lifecycle contracts.</li>
						<li>Child agents receive frozen instructions plus bounded, sanitized parent context.</li>
						<li>
							Background completions return once through wait_agent and remain recoverable after reloads.
						</li>
						<li>
							Integrated browser control and explicit context compaction round out the agent workflow.
						</li>
					</ul>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default memo(Announcement)
