export function ProductVideo() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-10 pb-20">
      <div className="overflow-hidden rounded-xl border border-border bg-background shadow-[0_16px_48px_rgba(17,17,17,0.12)]">
        {/* biome-ignore lint/a11y/useMediaCaption: silent looping product demo, no spoken audio */}
        <video
          className="aspect-[1748/1080] w-full object-contain"
          src="/oc-demo.mp4"
          title="How opencompany gives AI agents a living company brain"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      </div>
      <p className="mt-4 text-center font-mono text-[12px] text-ink-subtle">
        Connect sources to self-build your company wiki, codex and claude code run in cloud
        sandboxes
      </p>
    </section>
  );
}
