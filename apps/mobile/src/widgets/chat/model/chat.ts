export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "complete" | "thinking" | "streaming";
  isNew?: boolean;
};

export const STREAMING_CHUNK_SIZE = 10;
export const STREAMING_INTERVAL_MS = 50;
export const THINKING_DELAY_MS = 800;

const assistantMarkdownParts = [
  `# Black Holes

Black holes are among the most **fascinating** and _mysterious_ objects in the universe.

## What Is a Black Hole?

A black hole is a region of spacetime where gravity is so **extremely strong** that nothing — not even light or other electromagnetic waves — has enough energy to escape it.

The boundary of no escape is called the **event horizon**. Although it has a great effect on the fate and circumstances of an object crossing it, it has no locally detectable features according to \`general relativity\`.

`,
  `## Types of Black Holes

There are **three main types** of black holes:

1. **Stellar black holes** — formed by the gravitational collapse of a star
2. **Supermassive black holes** — found at the center of most galaxies
3. **Intermediate black holes** — a class between stellar and supermassive

`,
  `### Stellar Black Holes

When a massive star (_typically > 25 solar masses_) exhausts its nuclear fuel, it may collapse under its own gravity to form a stellar black hole.

### Supermassive Black Holes

These have masses ranging from **millions** to **billions** of solar masses. The supermassive black hole at the center of the Milky Way is called \`Sagittarius A*\`.

`,
  `## Key Properties

- **Mass**: Determines the size of the event horizon
- **Spin**: Black holes can rotate at nearly the speed of light
- **Charge**: Theoretically possible but astrophysically negligible

`,
  `## Famous Image

In 2019, the **Event Horizon Telescope** collaboration released the first-ever direct image of a black hole — the supermassive black hole in galaxy _Messier 87_.

![First image of a black hole, Messier 87](https://upload.wikimedia.org/wikipedia/commons/4/4f/Black_hole_-_Messier_87_crop_max_res.jpg)

> "We have seen what we thought was unseeable." — Sheperd Doeleman

Learn more at [NASA's Black Hole page](https://science.nasa.gov/astrophysics/focus-areas/black-holes).

---

_This content is for demonstration purposes only._
`,
] as const;

export const sampleMarkdown = assistantMarkdownParts.join("");

const userPrompts = [
  "What is a black hole?",
  "What are the main types of black holes?",
  "How do stellar and supermassive black holes form and differ?",
  "What key properties define a black hole?",
  "What famous black-hole image should I know about, and where can I learn more?",
] as const;

export const seedMessages: ChatMessage[] = userPrompts.flatMap((content, index) => [
  {
    id: `seed-user-${index + 1}`,
    role: "user",
    content,
    createdAt: index * 2 + 1,
    status: "complete",
  },
  {
    id: `seed-assistant-${index + 1}`,
    role: "assistant",
    content: assistantMarkdownParts[index],
    createdAt: index * 2 + 2,
    status: "complete",
  },
]);

let nextMessageSequence = seedMessages.length;

export function createMessageIdentity() {
  nextMessageSequence += 1;

  return {
    id: `message-${nextMessageSequence}`,
    createdAt: nextMessageSequence,
  };
}

export function getNextChunkIndex(currentIndex: number, contentLength: number) {
  return Math.min(currentIndex + STREAMING_CHUNK_SIZE, contentLength);
}
