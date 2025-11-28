import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Conversation {
  id: string;
  name: string;
  avatar?: string;
  lastMessage: string;
  timestamp: string;
  unread: number;
  isOnline?: boolean;
}

interface ConversationListProps {
  conversations: Conversation[];
  activeId?: string;
  onSelect: (id: string) => void;
}

export default function ConversationList({
  conversations,
  activeId,
  onSelect,
}: ConversationListProps) {
  return (
    <ScrollArea className="h-full" data-testid="conversation-list">
      <div className="space-y-1 p-2">
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`flex items-center gap-3 p-3 rounded-md cursor-pointer hover-elevate ${
              activeId === conv.id ? "bg-accent" : ""
            }`}
            onClick={() => onSelect(conv.id)}
            data-testid={`conversation-${conv.id}`}
          >
            <div className="relative">
              <Avatar className="h-12 w-12">
                <AvatarImage src={conv.avatar} alt={conv.name} />
                <AvatarFallback>{conv.name.charAt(0)}</AvatarFallback>
              </Avatar>
              {conv.isOnline && (
                <div className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-status-online border-2 border-background" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-medium truncate">{conv.name}</h4>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {conv.timestamp}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground truncate">
                  {conv.lastMessage}
                </p>
                {conv.unread > 0 && (
                  <Badge data-testid={`badge-unread-${conv.id}`}>
                    {conv.unread}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
