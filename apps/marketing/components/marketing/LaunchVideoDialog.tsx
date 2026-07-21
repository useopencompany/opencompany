"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@opencompany/ui/components/dialog";

const LAUNCH_VIDEO_URL =
  "https://www.youtube-nocookie.com/embed/heM1a-KZHVw?rel=0&modestbranding=1&controls=1";

export function LaunchVideoDialog() {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex cursor-pointer items-center rounded-none px-2 py-2.5 font-medium font-mono text-[13px] text-ink-subtle tracking-tight transition hover:text-ink">
        See how it works
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-5xl gap-0 overflow-hidden rounded-none border-white/15 bg-black p-0 [&_[data-slot=dialog-close]]:top-3 [&_[data-slot=dialog-close]]:right-3 [&_[data-slot=dialog-close]]:z-10 [&_[data-slot=dialog-close]]:bg-black/70 [&_[data-slot=dialog-close]]:p-2 [&_[data-slot=dialog-close]]:text-white [&_[data-slot=dialog-close]]:opacity-100">
        <DialogTitle className="sr-only">OpenCompany launch video</DialogTitle>
        <div className="aspect-video w-full">
          <iframe
            className="size-full"
            src={LAUNCH_VIDEO_URL}
            title="OpenCompany launch video"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
