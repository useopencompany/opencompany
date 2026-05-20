import Sidebar from "@/components/Sidebar";
import BrainView from "@/components/BrainView";

export default function BrainPage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <BrainView />
    </div>
  );
}
