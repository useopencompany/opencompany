import { LAUNCH_VIDEO_URL } from "./launch-video";

export function ProductVideo() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-10 pb-20">
      <div className="overflow-hidden rounded-xl border border-border bg-black shadow-[0_16px_48px_rgba(17,17,17,0.12)]">
        <div className="aspect-video w-full">
          <iframe
            className="size-full"
            src={LAUNCH_VIDEO_URL}
            title="How opencompany gives AI agents a living company brain"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </div>
      <p className="mt-4 text-center font-mono text-[12px] text-ink-subtle">
        Connects to 5+ sources. Ingests with background agents. Compiled truth. Inspired by{" "}
        <a
          href="https://github.com/garrytan/gbrain"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-ink"
        >
          gbrain
        </a>
        .
      </p>
    </section>
  );
}
