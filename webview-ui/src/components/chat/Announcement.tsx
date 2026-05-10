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
				<div>
					<p className="text-sm">
						Alpha v1 is here. Welcome to the first release of the Alpha-branded extension.
					</p>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default memo(Announcement)
