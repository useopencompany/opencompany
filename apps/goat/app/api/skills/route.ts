import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { listGoatSkillCatalog } from "@/lib/skills";

export async function GET() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const skills = await listGoatSkillCatalog(context.workspace.id);
  return NextResponse.json({ skills });
}
