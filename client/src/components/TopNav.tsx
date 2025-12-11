import { Search, MessageCircle, Bell, User, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "./ThemeToggle";
import logoImage from "@assets/IMG_6664_1765313819403.jpg";
import type { ReactNode } from "react";

interface TopNavProps {
  onMenuClick?: () => void;
  onSearchChange?: (value: string) => void;
  onMessagesClick?: () => void;
  onNotificationsClick?: () => void;
  onProfileClick?: () => void;
  unreadMessages?: number;
  unreadNotifications?: number;
  cartDrawer?: ReactNode;
}

export default function TopNav({
  onMenuClick,
  onSearchChange,
  onMessagesClick,
  onNotificationsClick,
  onProfileClick,
  unreadMessages = 0,
  unreadNotifications = 0,
  cartDrawer,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-50 h-16 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-full items-center justify-between gap-4 px-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            onClick={onMenuClick}
            className="md:hidden"
            data-testid="button-menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2" data-testid="text-logo">
            <img src={logoImage} alt="Outsyde" className="h-8 w-auto" />
            <span className="font-serif text-2xl font-bold text-primary">Outsyde</span>
          </div>
        </div>

        <div className="hidden md:flex flex-1 max-w-md mx-4">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search local businesses..."
              className="pl-10 rounded-full h-10"
              onChange={(e) => onSearchChange?.(e.target.value)}
              data-testid="input-search"
            />
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="md:hidden"
            data-testid="button-search-mobile"
          >
            <Search className="h-5 w-5" />
          </Button>

          <div className="relative">
            <Button
              size="icon"
              variant="ghost"
              onClick={onMessagesClick}
              data-testid="button-messages"
            >
              <MessageCircle className="h-5 w-5" />
            </Button>
            {unreadMessages > 0 && (
              <Badge
                className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
                data-testid="badge-unread-messages"
              >
                {unreadMessages}
              </Badge>
            )}
          </div>

          <div className="relative">
            <Button
              size="icon"
              variant="ghost"
              onClick={onNotificationsClick}
              data-testid="button-notifications"
            >
              <Bell className="h-5 w-5" />
            </Button>
            {unreadNotifications > 0 && (
              <Badge
                className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
                data-testid="badge-unread-notifications"
              >
                {unreadNotifications}
              </Badge>
            )}
          </div>

          {cartDrawer}

          <ThemeToggle />

          <Button
            size="icon"
            variant="ghost"
            onClick={onProfileClick}
            data-testid="button-profile"
          >
            <User className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </header>
  );
}
