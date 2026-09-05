import type {
  BlockContent,
  Definition,
  FootnoteDefinition,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type DocsRequest = Record<string, unknown>;

type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: { url: string };
  weightedFontFamily?: { fontFamily: string };
};

type StyledText = {
  text: string;
  spans: Array<{ start: number; end: number; style: TextStyle }>;
};

type Paragraph = StyledText & {
  namedStyleType: string;
  bulletPreset?: "BULLET_CHECKBOX" | "BULLET_DISC_CIRCLE_SQUARE" | "NUMBERED_DECIMAL_ALPHA_ROMAN";
  checked?: boolean;
  nestingDepth: number;
};

type IndexedParagraph = Paragraph & {
  startIndex: number;
  textStartIndex: number;
  endIndex: number;
};

export type GoogleDocsMarkdown = {
  text: string;
  requests: DocsRequest[];
};

export function compileGoogleDocsMarkdown(markdown: string, tabId: string): GoogleDocsMarkdown {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map(
    root.children
      .filter((node): node is Definition => node.type === "definition")
      .map((definition) => [definition.identifier.toLowerCase(), definition]),
  );
  const paragraphs: Paragraph[] = [];
  appendBlocks(root.children, paragraphs, definitions);

  const text = paragraphs
    .map((paragraph) => `${"\t".repeat(paragraph.nestingDepth)}${paragraph.text}`)
    .join("\n");
  if (!text) return { text: "", requests: [] };

  const indexed = indexParagraphs(paragraphs);
  const requests: DocsRequest[] = [resetInheritedTextStyle(text, tabId)];
  requests.push(...paragraphStyleRequests(indexed, tabId));
  requests.push(...inlineStyleRequests(indexed, tabId));
  requests.push(...bulletRequests(indexed, tabId));
  return { text, requests };
}

function appendBlocks(
  nodes: Array<RootContent | BlockContent>,
  paragraphs: Paragraph[],
  definitions: Map<string, Definition>,
  nestingDepth = 0,
) {
  for (const node of nodes) {
    if (node.type === "definition" || node.type === "footnoteDefinition") continue;
    if (node.type === "heading") {
      paragraphs.push({
        ...renderPhrasing(node.children, definitions),
        namedStyleType: node.depth === 1 ? "TITLE" : `HEADING_${Math.min(node.depth - 1, 5)}`,
        nestingDepth,
      });
      continue;
    }
    if (node.type === "paragraph") {
      paragraphs.push({
        ...renderPhrasing(node.children, definitions),
        namedStyleType: "NORMAL_TEXT",
        nestingDepth,
      });
      continue;
    }
    if (node.type === "list") {
      appendList(node, paragraphs, definitions, nestingDepth);
      continue;
    }
    if (node.type === "blockquote") {
      appendBlocks(node.children, paragraphs, definitions, nestingDepth + 1);
      continue;
    }
    if (node.type === "code") {
      for (const line of node.value.split("\n")) {
        paragraphs.push({
          text: line,
          spans: line
            ? [
                {
                  start: 0,
                  end: line.length,
                  style: { weightedFontFamily: { fontFamily: "Roboto Mono" } },
                },
              ]
            : [],
          namedStyleType: "NORMAL_TEXT",
          nestingDepth,
        });
      }
      continue;
    }
    if (node.type === "thematicBreak") {
      paragraphs.push({
        text: "────────",
        spans: [],
        namedStyleType: "NORMAL_TEXT",
        nestingDepth,
      });
      continue;
    }
    if (node.type === "table") {
      for (const [rowIndex, row] of node.children.entries()) {
        const rendered = joinStyled(
          row.children.map((cell) => renderPhrasing(cell.children, definitions)),
          "\t",
        );
        if (rowIndex === 0 && rendered.text) {
          rendered.spans.push({ start: 0, end: rendered.text.length, style: { bold: true } });
        }
        paragraphs.push({
          ...rendered,
          namedStyleType: "NORMAL_TEXT",
          nestingDepth,
        });
      }
      continue;
    }
    if (node.type === "html") {
      paragraphs.push({
        text: node.value,
        spans: [],
        namedStyleType: "NORMAL_TEXT",
        nestingDepth,
      });
    }
  }
}

function appendList(
  list: List,
  paragraphs: Paragraph[],
  definitions: Map<string, Definition>,
  nestingDepth: number,
) {
  for (const item of list.children) {
    const bulletPreset =
      item.checked !== null && item.checked !== undefined
        ? "BULLET_CHECKBOX"
        : list.ordered
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : "BULLET_DISC_CIRCLE_SQUARE";
    appendListItem(item, paragraphs, definitions, nestingDepth, bulletPreset);
  }
}

function appendListItem(
  item: ListItem,
  paragraphs: Paragraph[],
  definitions: Map<string, Definition>,
  nestingDepth: number,
  bulletPreset: NonNullable<Paragraph["bulletPreset"]>,
) {
  let emittedItemParagraph = false;
  for (const child of item.children) {
    if (child.type === "paragraph") {
      const rendered = renderPhrasing(child.children, definitions);
      paragraphs.push({
        ...rendered,
        namedStyleType: "NORMAL_TEXT",
        bulletPreset,
        checked: item.checked === true,
        nestingDepth,
      });
      emittedItemParagraph = true;
    } else if (child.type === "list") {
      appendList(child, paragraphs, definitions, nestingDepth + 1);
    } else {
      appendBlocks([child], paragraphs, definitions, nestingDepth + (emittedItemParagraph ? 1 : 0));
    }
  }
}

function renderPhrasing(
  nodes: PhrasingContent[],
  definitions: Map<string, Definition>,
  inheritedStyle: TextStyle = {},
): StyledText {
  const output: StyledText = { text: "", spans: [] };
  for (const node of nodes) {
    const start = output.text.length;
    if (node.type === "text") {
      output.text += node.value;
    } else if (node.type === "break") {
      output.text += "\n";
    } else if (node.type === "inlineCode") {
      output.text += node.value;
      addSpan(output, start, {
        ...inheritedStyle,
        weightedFontFamily: { fontFamily: "Roboto Mono" },
      });
      continue;
    } else if (node.type === "image") {
      const label = node.alt || node.title || node.url;
      output.text += label;
      addSpan(output, start, { ...inheritedStyle, ...linkStyle(node.url) });
      continue;
    } else if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier.toLowerCase());
      const label = node.alt || definition?.title || definition?.url || node.identifier;
      output.text += label;
      addSpan(output, start, {
        ...inheritedStyle,
        ...(definition ? linkStyle(definition.url) : {}),
      });
      continue;
    } else if (node.type === "footnoteReference") {
      output.text += `[${node.label ?? node.identifier}]`;
    } else if (node.type === "html") {
      output.text += node.value;
    } else {
      const style = { ...inheritedStyle };
      if (node.type === "strong") style.bold = true;
      if (node.type === "emphasis") style.italic = true;
      if (node.type === "delete") style.strikethrough = true;
      if (node.type === "link") Object.assign(style, linkStyle(node.url));
      if (node.type === "linkReference") {
        const definition = definitions.get(node.identifier.toLowerCase());
        if (definition) Object.assign(style, linkStyle(definition.url));
      }
      const rendered = renderPhrasing(node.children, definitions, style);
      output.text += rendered.text;
      output.spans.push(
        ...rendered.spans.map((span) => ({
          ...span,
          start: start + span.start,
          end: start + span.end,
        })),
      );
      continue;
    }
    addSpan(output, start, inheritedStyle);
  }
  return output;
}

function addSpan(output: StyledText, start: number, style: TextStyle) {
  if (output.text.length > start && Object.keys(style).length > 0) {
    output.spans.push({ start, end: output.text.length, style });
  }
}

function linkStyle(url: string): TextStyle {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? { link: { url } } : {};
  } catch {
    return {};
  }
}

function joinStyled(values: StyledText[], separator: string): StyledText {
  const output: StyledText = { text: "", spans: [] };
  for (const [index, value] of values.entries()) {
    if (index > 0) output.text += separator;
    const offset = output.text.length;
    output.text += value.text;
    output.spans.push(
      ...value.spans.map((span) => ({
        ...span,
        start: offset + span.start,
        end: offset + span.end,
      })),
    );
  }
  return output;
}

function indexParagraphs(paragraphs: Paragraph[]): IndexedParagraph[] {
  let startIndex = 1;
  return paragraphs.map((paragraph) => {
    const textStartIndex = startIndex + paragraph.nestingDepth;
    const indexed = {
      ...paragraph,
      startIndex,
      textStartIndex,
      endIndex: textStartIndex + paragraph.text.length + 1,
    };
    startIndex = indexed.endIndex;
    return indexed;
  });
}

function resetInheritedTextStyle(text: string, tabId: string): DocsRequest {
  return {
    updateTextStyle: {
      range: { startIndex: 1, endIndex: text.length + 1, tabId },
      textStyle: {},
      fields: "bold,italic,strikethrough,underline,link,weightedFontFamily",
    },
  };
}

function paragraphStyleRequests(paragraphs: IndexedParagraph[], tabId: string): DocsRequest[] {
  const groups = groupConsecutive(paragraphs, (paragraph) => paragraph.namedStyleType);
  return groups.map((group) => ({
    updateParagraphStyle: {
      range: {
        startIndex: group.first.startIndex,
        endIndex: group.last.endIndex,
        tabId,
      },
      paragraphStyle: { namedStyleType: group.first.namedStyleType },
      fields: "namedStyleType",
    },
  }));
}

function inlineStyleRequests(paragraphs: IndexedParagraph[], tabId: string): DocsRequest[] {
  return paragraphs.flatMap((paragraph) => {
    const spans = [...paragraph.spans];
    if (paragraph.checked && paragraph.text) {
      spans.push({
        start: 0,
        end: paragraph.text.length,
        style: { strikethrough: true },
      });
    }
    return spans
      .filter((span) => span.end > span.start && Object.keys(span.style).length > 0)
      .map((span) => ({
        updateTextStyle: {
          range: {
            startIndex: paragraph.textStartIndex + span.start,
            endIndex: paragraph.textStartIndex + span.end,
            tabId,
          },
          textStyle: span.style,
          fields: Object.keys(span.style).join(","),
        },
      }));
  });
}

function bulletRequests(paragraphs: IndexedParagraph[], tabId: string): DocsRequest[] {
  const bulletParagraphs = paragraphs.filter(
    (
      paragraph,
    ): paragraph is IndexedParagraph & {
      bulletPreset: NonNullable<Paragraph["bulletPreset"]>;
    } => Boolean(paragraph.bulletPreset),
  );
  return groupConsecutive(
    bulletParagraphs,
    (paragraph) => paragraph.bulletPreset,
    (left, right) => left.endIndex === right.startIndex,
  )
    .sort((left, right) => right.first.startIndex - left.first.startIndex)
    .map((group) => ({
      createParagraphBullets: {
        range: { startIndex: group.first.startIndex, endIndex: group.last.endIndex, tabId },
        bulletPreset: group.first.bulletPreset,
      },
    }));
}

function groupConsecutive<T>(
  values: T[],
  key: (value: T) => string,
  adjacent: (left: T, right: T) => boolean = () => true,
) {
  const groups: Array<{ first: T; last: T }> = [];
  for (const value of values) {
    const group = groups.at(-1);
    if (group && key(group.last) === key(value) && adjacent(group.last, value)) {
      group.last = value;
    } else {
      groups.push({ first: value, last: value });
    }
  }
  return groups;
}
