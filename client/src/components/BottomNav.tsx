import { Home, Search, PlusCircle, MessageCircle, User } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BottomNavProps {
  activeTab: "home" | "search" | "create" | "messages" | "profile";
  onTabChange: (tab: "home" | "search" | "create" | "messages" | "profile") => void;
  isVendor?: boolean;
}

export default function BottomNav({ activeTab, onTabChange, isVendor = false }: BottomNavProps) {
  const tabs = [
    { id: "home" as const, icon: Home, label: "Home" },
    { id: "search" as const, icon: Search, label: "Search" },
    ...(isVendor ? [{ id: "create" as const, icon: PlusCircle, label: "Post" }] : []),
    { id: "messages" as const, icon: MessageCircle, label: "Messages" },
    { id: "profile" as const, icon: User, label: "Profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background md:hidden">
      <div className="flex items-center justify-around h-16">
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            variant="ghost"
            size="icon"
            className={`flex-col h-14 w-14 gap-1 ${
              activeTab === tab.id ? "text-primary" : "text-muted-foreground"
            }`}
            onClick={() => onTabChange(tab.id)}
            data-testid={`button-nav-${tab.id}`}
          >
            <tab.icon className="h-5 w-5" />
            <span className="text-xs">{tab.label}</span>
          </Button>
        ))}
      </div>
    </nav>
  );
}
