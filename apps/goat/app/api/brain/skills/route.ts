import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { listGoatBrainSkillCatalog } from "@/lib/brain-skills";

export async function GET() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!context.activeBrain) return NextResponse.json({ skills: [] });

  const skills = await listGoatBrainSkillCatalog(context.activeBrain.id);
  return NextResponse.json({ skills });
}
