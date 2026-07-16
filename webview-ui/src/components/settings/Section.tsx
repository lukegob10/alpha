import { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

type SectionProps = HTMLAttributes<HTMLDivElement>

export const Section = ({ className, ...props }: SectionProps) => (
	<div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-5 box-border", className)} {...props} />
)
