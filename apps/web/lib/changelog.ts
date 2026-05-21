export type ChangeCategory =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export type ChangeSection = {
  category: ChangeCategory | string;
  items: string[];
};

export type Release = {
  version: string;
  date?: string;
  yanked?: boolean;
  link?: string;
  notes: string[];
  sections: ChangeSection[];
};

export type Changelog = {
  title: string;
  intro: string[];
  releases: Release[];
};

const KNOWN_CATEGORIES = new Set([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);

function normalizeCategory(raw: string): string {
  const trimmed = raw.trim();
  const match = [...KNOWN_CATEGORIES].find(
    (c) => c.toLowerCase() === trimmed.toLowerCase(),
  );
  return match ?? trimmed;
}

export function parseChangelog(source: string): Changelog {
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  let title = "Changelog";
  const intro: string[] = [];
  const releases: Release[] = [];
  const linkRefs = new Map<string, string>();

  let current: Release | null = null;
  let currentSection: ChangeSection | null = null;
  let seenTitle = false;
  let pendingItem: string[] | null = null;

  const flushItem = () => {
    if (pendingItem && pendingItem.length && currentSection) {
      currentSection.items.push(pendingItem.join("\n").trim());
    } else if (pendingItem && pendingItem.length && current) {
      current.notes.push(pendingItem.join("\n").trim());
    }
    pendingItem = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");

    const linkRef = line.match(/^\[([^\]]+)\]:\s*(\S+)/);
    if (linkRef) {
      flushItem();
      linkRefs.set(linkRef[1].toLowerCase(), linkRef[2]);
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      flushItem();
      title = h1[1].trim();
      seenTitle = true;
      current = null;
      currentSection = null;
      continue;
    }

    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      flushItem();
      const heading = h2[1].trim();
      const versionMatch = heading.match(
        /^\[?([^\]\s]+)\]?(?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(?:\s*\[?(YANKED)\]?)?/i,
      );
      const version = versionMatch ? versionMatch[1] : heading;
      const date = versionMatch?.[2];
      const yanked = !!versionMatch?.[3];
      current = {
        version,
        date,
        yanked,
        notes: [],
        sections: [],
      };
      currentSection = null;
      releases.push(current);
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3 && current) {
      flushItem();
      currentSection = {
        category: normalizeCategory(h3[1]),
        items: [],
      };
      current.sections.push(currentSection);
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      flushItem();
      pendingItem = [bullet[1]];
      continue;
    }

    const continuation = line.match(/^\s{2,}(\S.*)$/);
    if (continuation && pendingItem) {
      pendingItem.push(continuation[1]);
      continue;
    }

    if (line.trim() === "") {
      flushItem();
      continue;
    }

    if (!current && seenTitle) {
      intro.push(line);
    }
  }
  flushItem();

  for (const release of releases) {
    const ref = linkRefs.get(release.version.toLowerCase());
    if (ref) release.link = ref;
  }

  return {
    title,
    intro: collapseBlankLines(intro),
    releases,
  };
}

function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (buffer.length) {
        out.push(buffer.join(" "));
        buffer = [];
      }
    } else {
      buffer.push(line.trim());
    }
  }
  if (buffer.length) out.push(buffer.join(" "));
  return out;
}

export function renderInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;

  const patterns: Array<{
    regex: RegExp;
    build: (m: RegExpExecArray) => InlineToken;
  }> = [
    {
      regex: /\[([^\]]+)\]\(([^)\s]+)\)/,
      build: (m) => ({ kind: "link", text: m[1], href: m[2] }),
    },
    {
      regex: /`([^`]+)`/,
      build: (m) => ({ kind: "code", text: m[1] }),
    },
    {
      regex: /\*\*([^*]+)\*\*/,
      build: (m) => ({ kind: "strong", text: m[1] }),
    },
    {
      regex: /\b(https?:\/\/[^\s)]+)/,
      build: (m) => ({ kind: "link", text: m[1], href: m[1] }),
    },
  ];

  while (remaining.length) {
    let earliest: {
      index: number;
      match: RegExpExecArray;
      build: (m: RegExpExecArray) => InlineToken;
    } | null = null;
    for (const { regex, build } of patterns) {
      const m = regex.exec(remaining);
      if (m && (earliest === null || m.index < earliest.index)) {
        earliest = { index: m.index, match: m, build };
      }
    }
    if (!earliest) {
      tokens.push({ kind: "text", text: remaining });
      break;
    }
    if (earliest.index > 0) {
      tokens.push({ kind: "text", text: remaining.slice(0, earliest.index) });
    }
    tokens.push(earliest.build(earliest.match));
    remaining = remaining.slice(earliest.index + earliest.match[0].length);
  }

  return tokens;
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };
