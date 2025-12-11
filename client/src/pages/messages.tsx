import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import ConversationList from "@/components/ConversationList";
import ChatInterface from "@/components/ChatInterface";
import { Card } from "@/components/ui/card";
import { MessageCircle, Loader2 } from "lucide-react";
import { useChat, useConversationMessages } from "@/hooks/useChat";
import { getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/schema";

interface MessagesPageProps {
  targetVendorId?: string;
  onClearTarget?: () => void;
}

export default function MessagesPage({ targetVendorId, onClearTarget }: MessagesPageProps) {
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
  });

  const {
    conversations,
    conversationsLoading,
    isConnected,
    typingUsers,
    connect,
    sendMessage,
    sendTyping,
    markAsRead,
    createConversation,
  } = useChat(user?.id);

  const { data: messagesData, isLoading: messagesLoading } = useConversationMessages(
    activeConversation,
    user?.id
  );

  useEffect(() => {
    async function getToken() {
      try {
        const res = await fetch("/api/v1/auth/token");
        if (res.ok) {
          const data = await res.json();
          setAuthToken(data.accessToken);
        }
      } catch (e) {
        console.error("Failed to get token for WebSocket:", e);
      }
    }
    if (user?.id) {
      getToken();
    }
  }, [user?.id]);

  useEffect(() => {
    if (authToken) {
      connect(authToken);
    }
  }, [authToken, connect]);

  useEffect(() => {
    if (activeConversation) {
      markAsRead(activeConversation);
    }
  }, [activeConversation, markAsRead]);

  // Handle opening a conversation with a specific vendor
  useEffect(() => {
    async function handleTargetVendor() {
      if (!targetVendorId || !user?.id) return;
      
      // Check if there's already a conversation with this vendor
      const existingConv = conversations.find(
        (c) => c.otherParticipant?.id === targetVendorId
      );

      if (existingConv) {
        setActiveConversation(existingConv.id);
        onClearTarget?.();
      } else if (!createConversation.isPending) {
        // Create a new conversation
        try {
          const result = await createConversation.mutateAsync(targetVendorId);
          if (result.conversation) {
            setActiveConversation(result.conversation.id);
          }
          onClearTarget?.();
        } catch (error) {
          console.error("Failed to create conversation:", error);
          onClearTarget?.();
        }
      }
    }

    if (!conversationsLoading) {
      handleTargetVendor();
    }
  }, [targetVendorId, user?.id, conversations, conversationsLoading, createConversation, onClearTarget]);

  const formatConversationsForList = () => {
    return conversations.map((conv) => ({
      id: conv.id,
      name: conv.otherParticipant?.name || "Unknown",
      lastMessage: conv.lastMessagePreview || "No messages yet",
      timestamp: conv.lastMessageAt
        ? formatRelativeTime(new Date(conv.lastMessageAt))
        : "",
      unread: 0,
      isOnline: false,
    }));
  };

  const formatMessagesForChat = () => {
    if (!messagesData?.messages || !user) return [];
    
    return messagesData.messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      timestamp: new Date(msg.createdAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }),
      isOwn: msg.senderId === user.id,
      senderName: msg.senderName,
    }));
  };

  const activeConv = conversations.find((c) => c.id === activeConversation);

  const handleSendMessage = (content: string) => {
    if (!activeConversation) return;
    sendMessage(activeConversation, content);
  };

  const handleTypingStart = () => {
    if (activeConversation) {
      sendTyping(activeConversation, true);
    }
  };

  const handleTypingEnd = () => {
    if (activeConversation) {
      sendTyping(activeConversation, false);
    }
  };

  if (!user) {
    return (
      <div className="h-[calc(100vh-8rem)] flex items-center justify-center" data-testid="page-messages-loading">
        <Card className="p-8 text-center max-w-sm overflow-visible">
          <MessageCircle className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">Sign in to view messages</h2>
          <p className="text-muted-foreground">
            You need to be logged in to access your conversations
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex" data-testid="page-messages">
      <div
        className={`w-full md:w-80 border-r ${
          activeConversation ? "hidden md:block" : "block"
        }`}
      >
        <div className="p-4 border-b flex items-center justify-between gap-2">
          <h1 className="text-xl font-bold">Messages</h1>
          {isConnected && (
            <div className="flex items-center gap-1">
              <div className="h-2 w-2 rounded-full bg-status-online" />
              <span className="text-xs text-muted-foreground">Connected</span>
            </div>
          )}
        </div>
        {conversationsLoading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="p-8 text-center">
            <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No conversations yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Start a chat with a local business
            </p>
          </div>
        ) : (
          <ConversationList
            conversations={formatConversationsForList()}
            activeId={activeConversation || undefined}
            onSelect={setActiveConversation}
          />
        )}
      </div>

      <div
        className={`flex-1 ${
          activeConversation ? "block" : "hidden md:flex md:items-center md:justify-center"
        }`}
      >
        {activeConv ? (
          messagesLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ChatInterface
              recipientName={activeConv.otherParticipant?.name || "Unknown"}
              isOnline={isConnected}
              messages={formatMessagesForChat()}
              onSendMessage={handleSendMessage}
              onBack={() => setActiveConversation(null)}
              isTyping={typingUsers.has(activeConv.otherParticipant?.id || "")}
            />
          )
        ) : (
          <Card className="p-8 text-center max-w-sm overflow-visible">
            <MessageCircle className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">Your Messages</h2>
            <p className="text-muted-foreground">
              Select a conversation to start chatting with local businesses
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
