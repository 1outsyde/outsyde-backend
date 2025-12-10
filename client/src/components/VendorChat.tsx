import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Loader2, MessageCircle, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useChat, useConversationMessages } from "@/hooks/useChat";
import { apiRequest } from "@/lib/queryClient";

interface VendorChatProps {
  vendorId: string;
  vendorName: string;
  vendorAvatar?: string;
  onLoginRequired?: () => void;
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  isRead: boolean;
  readAt?: string;
  senderName?: string;
}

export default function VendorChat({
  vendorId,
  vendorName,
  vendorAvatar,
  onLoginRequired,
}: VendorChatProps) {
  const [message, setMessage] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [wsToken, setWsToken] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const { data: userData, isLoading: userLoading } = useQuery<{ user: User } | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok) return null;
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          return null;
        }
        return res.json();
      } catch {
        return null;
      }
    },
  });

  const user = userData?.user;
  const userId = user?.id;

  const {
    conversations,
    isConnected,
    connect,
    sendMessage,
    sendTyping,
    markAsRead,
    createConversation,
  } = useChat(userId);

  const { data: messagesData, isLoading: messagesLoading } = useConversationMessages(
    conversationId,
    userId
  );

  const messages = messagesData?.messages || [];

  useEffect(() => {
    if (userId && conversations.length > 0) {
      const existingConvo = conversations.find(
        (c) => c.otherParticipant?.id === vendorId
      );
      if (existingConvo) {
        setConversationId(existingConvo.id);
      }
    }
  }, [userId, conversations, vendorId]);

  useEffect(() => {
    if (userId && !isConnected && !wsToken) {
      fetch("/api/v1/auth/token", {
        method: "POST",
        credentials: "include",
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.token) {
            setWsToken(data.token);
            connect(data.token);
          }
        })
        .catch(console.error);
    } else if (userId && !isConnected && wsToken) {
      connect(wsToken);
    }
  }, [userId, isConnected, wsToken, connect]);

  useEffect(() => {
    if (conversationId) {
      markAsRead(conversationId);
    }
  }, [conversationId, messages, markAsRead]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleStartConversation = async () => {
    if (!userId) {
      onLoginRequired?.();
      return;
    }

    try {
      const result = await createConversation.mutateAsync(vendorId);
      if (result.conversation) {
        setConversationId(result.conversation.id);
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      }
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const handleSendMessage = async () => {
    if (!message.trim() || !conversationId) return;

    if (isConnected) {
      sendMessage(conversationId, message.trim());
      setMessage("");
    } else {
      try {
        await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
          content: message.trim(),
        });
        setMessage("");
      } catch (error) {
        console.error("Failed to send message:", error);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleTyping = (isTyping: boolean) => {
    if (conversationId) {
      sendTyping(conversationId, isTyping);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  if (userLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6" data-testid="chat-login-prompt">
        <MessageCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">Sign in to chat</h3>
        <p className="text-muted-foreground mb-4">
          Create an account or sign in to message {vendorName}
        </p>
        <Button onClick={onLoginRequired} data-testid="button-chat-login">
          <LogIn className="h-4 w-4 mr-2" />
          Sign In
        </Button>
      </div>
    );
  }

  if (!conversationId) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6" data-testid="chat-start-prompt">
        <Avatar className="h-16 w-16 mb-4">
          <AvatarImage src={vendorAvatar} alt={vendorName} />
          <AvatarFallback>{vendorName.charAt(0)}</AvatarFallback>
        </Avatar>
        <h3 className="text-lg font-medium mb-2">Chat with {vendorName}</h3>
        <p className="text-muted-foreground mb-4">
          Have a question? Start a conversation with this business.
        </p>
        <Button 
          onClick={handleStartConversation}
          disabled={createConversation.isPending}
          data-testid="button-start-chat"
        >
          {createConversation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <MessageCircle className="h-4 w-4 mr-2" />
          )}
          Start Conversation
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[400px] border rounded-md" data-testid="vendor-chat-container">
      <div className="flex items-center gap-3 p-3 border-b bg-muted/30">
        <Avatar className="h-10 w-10">
          <AvatarImage src={vendorAvatar} alt={vendorName} />
          <AvatarFallback>{vendorName.charAt(0)}</AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium">{vendorName}</p>
          <p className="text-xs text-muted-foreground">
            {isConnected ? "Online" : "Offline"}
          </p>
        </div>
      </div>

      <ScrollArea className="flex-1 p-4">
        {messagesLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg: Message) => {
              const isOwnMessage = msg.senderId === userId;
              return (
                <div
                  key={msg.id}
                  className={`flex ${isOwnMessage ? "justify-end" : "justify-start"}`}
                  data-testid={`message-${msg.id}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-3 py-2 ${
                      isOwnMessage
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    <p className="text-sm break-words">{msg.content}</p>
                    <p
                      className={`text-xs mt-1 ${
                        isOwnMessage ? "text-primary-foreground/70" : "text-muted-foreground"
                      }`}
                    >
                      {formatTime(msg.createdAt)}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </ScrollArea>

      <div className="p-3 border-t">
        <div className="flex items-center gap-2">
          <Input
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              handleTyping(e.target.value.length > 0);
            }}
            onBlur={() => handleTyping(false)}
            onKeyPress={handleKeyPress}
            placeholder="Type a message..."
            className="flex-1"
            data-testid="input-vendor-chat"
          />
          <Button
            size="icon"
            onClick={handleSendMessage}
            disabled={!message.trim()}
            data-testid="button-send-vendor-chat"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
