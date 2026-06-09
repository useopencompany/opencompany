import { Sparkles } from "lucide-react";
import type { SlashCommand } from "@/lib/slash-commands/registry";

/** A workspace skill attached to the current agent, surfaced as a slash command. */
export type SkillCommandSource = {
  /** Mount id, e.g. `graphify-test` — used to build the `@skill/<id>` mention. */
  id: string;
  name: string;
  description?: string | null;
  /**
   * The slash-command slug from SKILL.md frontmatter (already normalized to `[a-z0-9_]`). When a
   * skill declares none, the command slug falls back to a slug of its name.
   */
  command?: string | null;
};

// Normalize a string into a slash-token slug. Mirrors `normalizeSkillCommand` in the runtime
// (`skill-resolver.ts`) so a stored command and a freshly-typed one resolve identically; the
// matcher token regex is `/^\/(\w+)/` ([A-Za-z0-9_]), so spaces/hyphens collapse to underscores.
export function toSlashSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build slash commands for the skills attached to the current agent. A skill's declared `command`
 * is used when present; otherwise the slug falls back to the skill name (then its mount id), so
 * every attached skill is reachable via `/<command>`. Built-ins win on collision (a skill can't
 * shadow `/clear`); duplicate skill slugs are disambiguated with a numeric suffix. Invoking one
 * inserts the skill's `@skill/<id>` mention at the caret — a textual cue the user keeps typing
 * around (the skill is already active because it is attached; the runtime does not parse mentions
 * from chat input).
 */
export function buildSkillSlashCommands(
  skills: SkillCommandSource[],
  reservedIds: Set<string>,
): SlashCommand[] {
  const used = new Set(reservedIds);
  const out: SlashCommand[] = [];
  for (const skill of skills) {
    const base =
      toSlashSlug(skill.command ?? "") || toSlashSlug(skill.name) || toSlashSlug(skill.id);
    if (!base || reservedIds.has(base)) continue; // skip unsluggable + built-in collisions

    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}${n++}`;
    used.add(slug);

    const name = skill.name || skill.id;
    out.push({
      id: slug,
      trigger: `/${slug}`,
      title: name,
      description: skill.description?.trim() || `Use the ${name} skill`,
      icon: Sparkles,
      keywords: ["skill", name],
      // Picking the command swaps the slash token straight for the mention — no second send step.
      applyOnSelect: true,
      run: ({ insertMention }) => insertMention(`@skill/${skill.id} `),
    });
  }
  return out;
}
