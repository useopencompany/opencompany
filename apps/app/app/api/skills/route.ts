import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { listSkillCatalog } from "@/lib/skills";

export async function GET() {
  const context = await currentUser({ optional: true });
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const skills = await listSkillCatalog(context.workspace.id);
  return NextResponse.json({ skills });
}
