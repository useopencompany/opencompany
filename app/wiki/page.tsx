import Sidebar from "@/components/Sidebar";
import WikiView from "@/components/WikiView";

export default function WikiPage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <WikiView />
    </div>
  );
}
