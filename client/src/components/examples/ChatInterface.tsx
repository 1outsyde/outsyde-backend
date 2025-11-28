import { useState } from "react";
import ChatInterface from "../ChatInterface";

export default function ChatInterfaceExample() {
  const [messages, setMessages] = useState([
    {
      id: "1",
      content: "Hi! I saw your coffee shop on Outsyde. Do you have any vegan options?",
      timestamp: "10:30 AM",
      isOwn: true,
    },
    {
      id: "2",
      content: "Hello! Yes, we have several vegan options including oat milk lattes, almond milk cappuccinos, and a variety of vegan pastries!",
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
  ]);

  const handleSend = (content: string) => {
    setMessages([
      ...messages,
      {
        id: String(messages.length + 1),
        content,
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }),
        isOwn: true,
      },
    ]);
  };

  return (
    <div className="max-w-md">
      <ChatInterface
        recipientName="Sunrise Coffee Co."
        isOnline={true}
        messages={messages}
        onSendMessage={handleSend}
        onBack={() => console.log("Back clicked")}
      />
    </div>
  );
}
