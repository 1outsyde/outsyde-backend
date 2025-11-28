import { useState } from "react";
import BottomNav from "../BottomNav";

export default function BottomNavExample() {
  const [activeTab, setActiveTab] = useState<"home" | "search" | "create" | "messages" | "profile">("home");

  return (
    <div className="h-20 relative">
      <BottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isVendor={true}
      />
    </div>
  );
}
