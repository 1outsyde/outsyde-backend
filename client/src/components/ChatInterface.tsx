import { useState, useRef, useEffect } from "react";
import { Send, Paperclip, ArrowLeft } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import ChatMessage from "./ChatMessage";

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
  senderName?: string;
  senderAvatar?: string;
}

interface ChatInterfaceProps {
  recipientName: string;
  recipientAvatar?: string;
  isOnline?: boolean;
  messages: Message[];
  onSendMessage?: (content: string) => void;
  onBack?: () => void;
  isTyping?: boolean;
}

export default function ChatInterface({
  recipientName,
  recipientAvatar,
  isOnline = false,
  messages,
  onSendMessage,
  onBack,
  isTyping = false,
}: ChatInterfaceProps) {
  const [inputValue, setInputValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (inputValue.trim()) {
      onSendMessage?.(inputValue.trim());
      setInputValue("");
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Card className="flex flex-col h-[500px] overflow-hidden" data-testid="chat-interface">
      <div className="flex items-center gap-3 p-4 border-b">
        {onBack && (
          <Button size="icon" variant="ghost" onClick={onBack} data-testid="button-chat-back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        <Avatar className="h-10 w-10">
          <AvatarImage src={recipientAvatar} alt={recipientName} />
          <AvatarFallback>{recipientName.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h3 className="font-semibold" data-testid="text-recipient-name">{recipientName}</h3>
          <div className="flex items-center gap-1">
            <div
              className={`h-2 w-2 rounded-full ${
                isOnline ? "bg-status-online" : "bg-status-offline"
              }`}
            />
            <span className="text-xs text-muted-foreground">
              {isOnline ? "Online" : "Offline"}
            </span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        <div className="space-y-4">
          {messages.map((message) => (
            <ChatMessage key={message.id} {...message} />
          ))}
          {isTyping && (
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="typing-indicator">
              <div className="flex gap-1">
                <div className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-sm">{recipientName} is typing...</span>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-4 border-t">
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" data-testid="button-attach">
            <Paperclip className="h-5 w-5" />
          </Button>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Type a message..."
            className="flex-1"
            data-testid="input-message"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!inputValue.trim()}
            data-testid="button-send"
          >
            <Send className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
