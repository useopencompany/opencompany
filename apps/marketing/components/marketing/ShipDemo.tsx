import { SHIP_DEMO_VIDEO_URL } from "./ship-demo-video";

export function ShipDemo() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-10 pb-20">
      <div className="overflow-hidden rounded-xl border border-border bg-black shadow-[0_16px_48px_rgba(17,17,17,0.12)]">
        <div className="aspect-video w-full">
          {SHIP_DEMO_VIDEO_URL ? (
            <iframe
              className="size-full"
              src={SHIP_DEMO_VIDEO_URL}
              title="Ship: from bug report to opened PR"
              loading="lazy"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="font-mono text-[12px] text-white/40 uppercase tracking-widest">
                Demo — coming soon
              </p>
              <p className="max-w-md font-mono text-[15px] text-white/80 leading-7">
                Slack ticket → Ship picks it up → Codex builds with your conventions → PR opens
                for review.
              </p>
            </div>
          )}
        </div>
      </div>
      <p className="mt-4 text-center font-mono text-[12px] text-ink-subtle">
        The whole loop, start to finish — no manual triage, no blank branch.
      </p>
    </section>
  );
}
