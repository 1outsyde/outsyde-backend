import { useState } from "react";
import ConversationList from "../ConversationList";

export default function ConversationListExample() {
  const [activeId, setActiveId] = useState<string | undefined>();

  const conversations = [
    {
      id: "1",
      name: "Sunrise Coffee Co.",
      lastMessage: "Looking forward to seeing you!",
      timestamp: "10:35 AM",
      unread: 2,
      isOnline: true,
    },
    {
      id: "2",
      name: "Bella's Hair Studio",
      lastMessage: "Your appointment is confirmed for tomorrow",
      timestamp: "Yesterday",
      unread: 0,
      isOnline: false,
    },
    {
      id: "3",
      name: "Green Valley Organics",
      lastMessage: "Thanks for your order!",
      timestamp: "2 days ago",
      unread: 1,
      isOnline: true,
    },
  ];

  return (
    <div className="h-[400px] w-80 border rounded-md">
      <ConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={setActiveId}
      />
    </div>
  );
}
