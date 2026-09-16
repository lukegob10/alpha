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
						Alpha v{Package.version} makes background editing safer and calmer while preserving the proven
						Code loop.
					</p>
					<ul className="list-disc space-y-1 pl-5">
						<li>Background edits keep your focus, open tabs, cursor, and unsaved typing in place.</li>
						<li>Cancelled or abandoned saves stop before a late write can change the workspace.</li>
						<li>Directory reads explain how to continue with the list-files tool.</li>
						<li>Background command results now report their actual exit status to the next model step.</li>
					</ul>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default memo(Announcement)
