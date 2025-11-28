import { useState } from "react";
import ConversationList from "@/components/ConversationList";
import ChatInterface from "@/components/ChatInterface";
import { Card } from "@/components/ui/card";
import { MessageCircle } from "lucide-react";

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isOwn: boolean;
  senderName?: string;
  senderAvatar?: string;
}

interface Conversation {
  id: string;
  name: string;
  avatar?: string;
  lastMessage: string;
  timestamp: string;
  unread: number;
  isOnline?: boolean;
  messages: Message[];
}

export default function MessagesPage() {
  const [activeConversation, setActiveConversation] = useState<string | null>(null);

  // todo: remove mock functionality
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: "1",
      name: "Sunrise Coffee Co.",
      lastMessage: "Looking forward to seeing you!",
      timestamp: "10:35 AM",
      unread: 2,
      isOnline: true,
      messages: [
        {
          id: "1",
          content: "Hi! I saw your coffee shop on Outsyde. Do you have any vegan options?",
          timestamp: "10:30 AM",
          isOwn: true,
        },
        {
          id: "2",
          content: "Hello! Yes, we have several vegan options including oat milk lattes and vegan pastries!",
          timestamp: "10:32 AM",
          isOwn: false,
          senderName: "Sunrise Coffee",
        },
        {
          id: "3",
          content: "That sounds great! What time do you open tomorrow?",
          timestamp: "10:33 AM",
          isOwn: true,
        },
        {
          id: "4",
          content: "We open at 7 AM! Looking forward to seeing you.",
          timestamp: "10:35 AM",
          isOwn: false,
          senderName: "Sunrise Coffee",
        },
      ],
    },
    {
      id: "2",
      name: "Bella's Hair Studio",
      lastMessage: "Your appointment is confirmed for tomorrow",
      timestamp: "Yesterday",
      unread: 0,
      isOnline: false,
      messages: [
        {
          id: "1",
          content: "Hi, I'd like to book a hair styling appointment",
          timestamp: "Yesterday",
          isOwn: true,
        },
        {
          id: "2",
          content: "Your appointment is confirmed for tomorrow at 2 PM!",
          timestamp: "Yesterday",
          isOwn: false,
          senderName: "Bella's Hair Studio",
        },
      ],
    },
    {
      id: "3",
      name: "Green Valley Organics",
      lastMessage: "Thanks for your order!",
      timestamp: "2 days ago",
      unread: 0,
      isOnline: true,
      messages: [
        {
          id: "1",
          content: "Just placed an order for organic vegetables",
          timestamp: "2 days ago",
          isOwn: true,
        },
        {
          id: "2",
          content: "Thanks for your order! It will be ready for pickup tomorrow.",
          timestamp: "2 days ago",
          isOwn: false,
          senderName: "Green Valley",
        },
      ],
    },
  ]);

  const activeConv = conversations.find((c) => c.id === activeConversation);

  const handleSendMessage = (content: string) => {
    if (!activeConversation) return;

    const newMessage: Message = {
      id: String(Date.now()),
      content,
      timestamp: new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }),
      isOwn: true,
    };

    setConversations(
      conversations.map((conv) =>
        conv.id === activeConversation
          ? {
              ...conv,
              messages: [...conv.messages, newMessage],
              lastMessage: content,
              timestamp: "Just now",
            }
          : conv
      )
    );
  };

  return (
    <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex" data-testid="page-messages">
      <div
        className={`w-full md:w-80 border-r ${
          activeConversation ? "hidden md:block" : "block"
        }`}
      >
        <div className="p-4 border-b">
          <h1 className="text-xl font-bold">Messages</h1>
        </div>
        <ConversationList
          conversations={conversations}
          activeId={activeConversation || undefined}
          onSelect={setActiveConversation}
        />
      </div>

      <div
        className={`flex-1 ${
          activeConversation ? "block" : "hidden md:flex md:items-center md:justify-center"
        }`}
      >
        {activeConv ? (
          <ChatInterface
            recipientName={activeConv.name}
            recipientAvatar={activeConv.avatar}
            isOnline={activeConv.isOnline}
            messages={activeConv.messages}
            onSendMessage={handleSendMessage}
            onBack={() => setActiveConversation(null)}
          />
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
