"use client";

import { Input } from "@opencompany/ui/components/input";
import {
  AnthropicIcon,
  ArrowRight,
  Bell,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  DeepSeekIcon,
  Download,
  ExternalLink,
  Eye,
  File,
  FileText,
  Filter,
  Folder,
  GeminiIcon,
  Heart,
  Home,
  Info,
  InstagramIcon,
  Layers,
  Link,
  Lock,
  LogOut,
  type LucideIcon,
  Mail,
  MessageSquare,
  MinimaxIcon,
  MistralIcon,
  Moon,
  MoonshotIcon,
  MoreHorizontal,
  OpenAIIcon,
  OpenCompanyMark,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Users,
  X,
  XaiIcon,
  ZaiIcon,
  Zap,
} from "@opencompany/ui/icons";
import { useMemo, useState } from "react";
import { PageHeader, SectionTitle } from "@/components/docs-primitives";

const ICONS: { name: string; Icon: LucideIcon }[] = [
  { name: "ArrowRight", Icon: ArrowRight },
  { name: "Bell", Icon: Bell },
  { name: "Bookmark", Icon: Bookmark },
  { name: "Calendar", Icon: Calendar },
  { name: "Check", Icon: Check },
  { name: "ChevronDown", Icon: ChevronDown },
  { name: "ChevronRight", Icon: ChevronRight },
  { name: "Clock", Icon: Clock },
  { name: "Copy", Icon: Copy },
  { name: "CreditCard", Icon: CreditCard },
  { name: "Download", Icon: Download },
  { name: "ExternalLink", Icon: ExternalLink },
  { name: "Eye", Icon: Eye },
  { name: "File", Icon: File },
  { name: "FileText", Icon: FileText },
  { name: "Filter", Icon: Filter },
  { name: "Folder", Icon: Folder },
  { name: "Heart", Icon: Heart },
  { name: "Home", Icon: Home },
  { name: "Info", Icon: Info },
  { name: "Layers", Icon: Layers },
  { name: "Link", Icon: Link },
  { name: "Lock", Icon: Lock },
  { name: "LogOut", Icon: LogOut },
  { name: "Mail", Icon: Mail },
  { name: "MessageSquare", Icon: MessageSquare },
  { name: "Moon", Icon: Moon },
  { name: "MoreHorizontal", Icon: MoreHorizontal },
  { name: "Plus", Icon: Plus },
  { name: "Search", Icon: Search },
  { name: "Send", Icon: Send },
  { name: "Settings", Icon: Settings },
  { name: "Sparkles", Icon: Sparkles },
  { name: "Star", Icon: Star },
  { name: "Sun", Icon: Sun },
  { name: "Tag", Icon: Tag },
  { name: "Trash2", Icon: Trash2 },
  { name: "TriangleAlert", Icon: TriangleAlert },
  { name: "Upload", Icon: Upload },
  { name: "User", Icon: User },
  { name: "Users", Icon: Users },
  { name: "X", Icon: X },
  { name: "Zap", Icon: Zap },
];

const PRODUCT: { name: string; Icon: LucideIcon }[] = [
  { name: "OpenCompanyMark", Icon: OpenCompanyMark },
];

const PROVIDERS: { name: string; Icon: LucideIcon }[] = [
  { name: "OpenAIIcon", Icon: OpenAIIcon },
  { name: "AnthropicIcon", Icon: AnthropicIcon },
  { name: "GeminiIcon", Icon: GeminiIcon },
  { name: "DeepSeekIcon", Icon: DeepSeekIcon },
  { name: "MistralIcon", Icon: MistralIcon },
  { name: "MoonshotIcon", Icon: MoonshotIcon },
  { name: "ZaiIcon", Icon: ZaiIcon },
  { name: "XaiIcon", Icon: XaiIcon },
  { name: "MinimaxIcon", Icon: MinimaxIcon },
  { name: "InstagramIcon", Icon: InstagramIcon },
];

function IconCard({ name, Icon }: { name: string; Icon: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center">
      <Icon className="size-5 text-foreground" />
      <code className="truncate text-[10px] text-muted-foreground" title={name}>
        {name}
      </code>
    </div>
  );
}

export default function IconsPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ICONS;
    return ICONS.filter((i) => i.name.toLowerCase().includes(q));
  }, [query]);

  return (
    <article>
      <PageHeader
        title="Icons"
        description="The system standardizes on Iconists Central (square / outlined) for UI glyphs, plus project-owned brand and model-provider logos — all imported from @opencompany/ui/icons. Every icon inherits currentColor, so text-* and size-* utilities tint and size them uniformly."
      />

      <SectionTitle>Product</SectionTitle>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {PRODUCT.map((icon) => (
          <IconCard key={icon.name} {...icon} />
        ))}
      </div>

      <SectionTitle>Model providers &amp; social</SectionTitle>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {PROVIDERS.map((icon) => (
          <IconCard key={icon.name} {...icon} />
        ))}
      </div>

      <SectionTitle>UI glyphs</SectionTitle>
      <Input
        placeholder="Search icons…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-6 max-w-sm"
      />
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {filtered.map((icon) => (
          <IconCard key={icon.name} {...icon} />
        ))}
        {filtered.length === 0 ? (
          <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
            No icons match “{query}”.
          </p>
        ) : null}
      </div>
    </article>
  );
}
