import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface ChatMessageProps {
  id: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
  senderName?: string;
  senderAvatar?: string;
}

export default function ChatMessage({
  id,
  content,
  timestamp,
  isOwn,
  senderName,
  senderAvatar,
}: ChatMessageProps) {
  return (
    <div
      className={`flex gap-2 ${isOwn ? "flex-row-reverse" : "flex-row"}`}
      data-testid={`message-${id}`}
    >
      {!isOwn && (
        <Avatar className="h-8 w-8">
          <AvatarImage src={senderAvatar} alt={senderName} />
          <AvatarFallback>{senderName?.charAt(0) || "?"}</AvatarFallback>
        </Avatar>
      )}
      <div className={`max-w-[70%] ${isOwn ? "items-end" : "items-start"}`}>
        <div
          className={`rounded-2xl px-4 py-2 ${
            isOwn
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : "bg-muted rounded-bl-sm"
          }`}
        >
          <p className="text-sm">{content}</p>
        </div>
        <span className="text-xs text-muted-foreground mt-1 block">
          {timestamp}
        </span>
      </div>
    </div>
  );
}
