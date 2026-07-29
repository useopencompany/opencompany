// Square grid, strongest at the top-left and fading out toward the bottom-right,
// with a crosshair marking the grid's origin. Shared by any section that wants
// the same textured backdrop (Hero, WhySwitch, ship hero, ...).
export function GridBackdrop() {
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 top-12 bg-[linear-gradient(to_right,rgba(17,17,17,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(17,17,17,0.06)_1px,transparent_1px)] bg-[size:56px_56px] [-webkit-mask-image:linear-gradient(to_bottom_right,black,transparent_65%)] [mask-image:linear-gradient(to_bottom_right,black,transparent_65%)]"
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 22 22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        className="-translate-x-1/2 -translate-y-1/2 absolute top-12 left-0 size-[22px] text-ink/60"
      >
        <path d="M11 0v22M0 11h22" />
      </svg>
    </>
  );
}
