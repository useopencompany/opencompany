"use client";

// One shared popup for every tiptap `@tiptap/suggestion` menu in the editor
// (the "/" slash menu and the "@" skill mention menu). It owns the two things
// those menus used to each reimplement differently: keyboard navigation (the
// idiomatic forwardRef + useImperativeHandle handle the Suggestion plugin
// forwards keys to) and popup positioning (Floating UI, so the menu flips and
// shifts instead of overflowing near a viewport edge). Callers only supply how
// to render a row.

import type { VirtualElement } from "@floating-ui/dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import {
  type ComponentType,
  type ForwardedRef,
  forwardRef,
  type ReactElement,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useState,
} from "react";

export type SuggestionListHandle = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type SuggestionMenuProps<TItem> = {
  items: TItem[];
  onSelect: (item: TItem) => void;
  renderItem: (item: TItem, active: boolean) => ReactNode;
  getKey: (item: TItem, index: number) => string;
  ariaLabel: string;
  emptyLabel: string;
};

function SuggestionMenuInner<TItem>(
  { items, onSelect, renderItem, getKey, ariaLabel, emptyLabel }: SuggestionMenuProps<TItem>,
  ref: ForwardedRef<SuggestionListHandle>,
) {
  const [active, setActive] = useState(0);

  // Every keystroke narrows the list (a fresh `items` identity); snap the
  // highlight back to the top. Adjusting state during render is React's
  // recommended alternative to a setState-in-effect.
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    setActive(0);
  }

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setActive((current) => (current + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setActive((current) => (current - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[active];
          if (item) onSelect(item);
          return true;
        }
        return false;
      },
    }),
    [active, items, onSelect],
  );

  if (items.length === 0) {
    return (
      <div className="w-72 rounded-lg bg-surface px-3 py-2.5 text-[12.5px] leading-4 text-ink-subtle shadow-ring-md">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label={ariaLabel}
      className="max-h-72 w-80 overflow-y-auto rounded-lg bg-surface p-1 shadow-ring-md"
    >
      {items.map((item, index) => {
        const isActive = index === active;
        return (
          <button
            key={getKey(item, index)}
            type="button"
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => setActive(index)}
            // preventDefault on mousedown keeps the editor's caret/focus; the
            // actual selection happens on click so real clicks and synthetic
            // ones (fireEvent.click) resolve through the same path.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-hover focus:outline-none ${
              isActive ? "bg-surface-hover" : ""
            }`}
          >
            {renderItem(item, isActive)}
          </button>
        );
      })}
    </div>
  );
}

// forwardRef erases the generic; callers get their item type back through the
// per-instance cast in createSuggestionRenderer below.
const SuggestionMenu = forwardRef(SuggestionMenuInner) as <TItem>(
  props: SuggestionMenuProps<TItem> & { ref?: Ref<SuggestionListHandle> },
) => ReactElement;

export type SuggestionRendererConfig<TItem> = {
  ariaLabel: string;
  emptyLabel: string;
  getKey: (item: TItem, index: number) => string;
  renderItem: (item: TItem, active: boolean) => ReactNode;
};

/**
 * Builds the `render` half of a tiptap SuggestionOptions: mounts the shared
 * menu, positions it under the caret with Floating UI, and forwards keys to it.
 */
export function createSuggestionRenderer<TItem>(
  config: SuggestionRendererConfig<TItem>,
): NonNullable<SuggestionOptions<TItem>["render"]> {
  return () => {
    let renderer: ReactRenderer<SuggestionListHandle, SuggestionMenuProps<TItem>> | null = null;
    let container: HTMLDivElement | null = null;
    let stopPositioning: (() => void) | null = null;

    const toProps = (props: {
      items: TItem[];
      command: (item: TItem) => void;
    }): SuggestionMenuProps<TItem> => ({
      items: props.items,
      onSelect: (item) => props.command(item),
      renderItem: config.renderItem,
      getKey: config.getKey,
      ariaLabel: config.ariaLabel,
      emptyLabel: config.emptyLabel,
    });

    const place = (getRect: (() => DOMRect | null) | null | undefined) => {
      if (!container || !getRect) return;
      stopPositioning?.();
      const reference: VirtualElement = {
        getBoundingClientRect: () => getRect() ?? new DOMRect(),
      };
      stopPositioning = autoUpdate(reference, container, () => {
        if (!container) return;
        computePosition(reference, container, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          if (!container) return;
          container.style.left = `${x}px`;
          container.style.top = `${y}px`;
        });
      });
    };

    return {
      onStart: (props) => {
        renderer = new ReactRenderer<SuggestionListHandle, SuggestionMenuProps<TItem>>(
          SuggestionMenu as ComponentType<SuggestionMenuProps<TItem>>,
          { props: toProps(props), editor: props.editor },
        );
        container = document.createElement("div");
        container.style.position = "fixed";
        container.style.top = "0";
        container.style.left = "0";
        container.style.zIndex = "90";
        container.appendChild(renderer.element);
        document.body.appendChild(container);
        place(props.clientRect);
      },
      onUpdate: (props) => {
        renderer?.updateProps(toProps(props));
        place(props.clientRect);
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") return false;
        return renderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        stopPositioning?.();
        stopPositioning = null;
        renderer?.destroy();
        renderer = null;
        container?.remove();
        container = null;
      },
    };
  };
}
