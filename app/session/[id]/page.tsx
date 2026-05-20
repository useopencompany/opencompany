import Sidebar from "@/components/Sidebar";
import ChatView from "@/components/ChatView";

export default function SessionPage() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <ChatView />
    </div>
  );
}
