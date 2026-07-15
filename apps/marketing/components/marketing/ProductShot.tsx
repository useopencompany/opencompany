import Image from "next/image";

export function ProductShot() {
  return (
    <section className="mx-auto max-w-5xl px-6 pt-10 pb-20">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <Image
          src="/product-brain-overview-v2.png"
          alt="OpenCompany brain overview — sources, recent activity, and linked knowledge"
          width={2448}
          height={1852}
          priority
          className="h-auto w-full"
        />
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
