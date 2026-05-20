import Sidebar from "@/components/Sidebar";
import MainPanel from "@/components/MainPanel";

export default function Home() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <MainPanel />
    </div>
  );
}
