"use client";

import { LayoutRoot, Resizer } from "react-splitkit";
import { SessionPanel } from "./SessionPanel";

/**
 * Wraps react-splitkit's `LayoutRoot`, which recursively renders the layout
 * tree (flex containers + sizing are handled by the library; pane chrome and
 * resizer visuals are ours). A div, not <main> — pane content (SessionView)
 * brings its own <main>.
 */
export function SessionLayout({ showHeaderWhenSingle = true }: { showHeaderWhenSingle?: boolean }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <LayoutRoot
        className="flex-1"
        renderPanel={({ panel, style }) => (
          <SessionPanel panel={panel} style={style} showHeaderWhenSingle={showHeaderWhenSingle} />
        )}
        renderResizer={({ splitId, index }) => (
          // The library fixes the resizer at 4px (with a 24px touch hit area)
          // and handles pointer + keyboard resize with min/max constraints.
          <Resizer
            splitId={splitId}
            index={index}
            className="bg-border transition-colors duration-150 hover:bg-accent data-[resizing]:bg-accent"
          />
        )}
      />
    </div>
  );
}
