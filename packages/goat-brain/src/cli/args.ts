export type ParsedArgs = {
  positionals: string[];
  get(name: string): string | undefined;
  getAll(name: string): string[];
  has(name: string): boolean;
  names(): string[];
  number(name: string): number | undefined;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      push(flags, body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      push(flags, body, "true");
    } else {
      push(flags, body, next);
      i++;
    }
  }
  return {
    positionals,
    get: (name) => flags.get(name)?.[0],
    getAll: (name) => flags.get(name) ?? [],
    has: (name) => flags.has(name),
    names: () => [...flags.keys()],
    number: (name) => {
      const raw = flags.get(name)?.[0];
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    },
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function push(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing) existing.push(value);
  else flags.set(name, [value]);
}
