import { DevicesView } from "@/components/settings/DevicesView";
import { currentWorkspace } from "@/lib/auth";
import { loadMyDeviceActions, loadMyDevices } from "@/lib/devices/actions";

export const dynamic = "force-dynamic";

export default async function PersonalDevicesPage() {
  await currentWorkspace();
  const [devices, actions] = await Promise.all([loadMyDevices(), loadMyDeviceActions()]);
  return (
    <div className="h-full overflow-y-auto">
      <DevicesView devices={devices} actions={actions} />
    </div>
  );
}
