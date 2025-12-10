import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

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

interface Conversation {
  id: string;
  participant1Id: string;
  participant2Id: string;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  createdAt: string;
  otherParticipant: {
    id: string;
    name: string;
  };
}

interface WSMessage {
  type: string;
  payload: any;
}

export function useChat(userId: string | undefined) {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Map<string, boolean>>(new Map());
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;
  const queryClient = useQueryClient();

  const { data: conversationsData, isLoading: conversationsLoading } = useQuery<{ conversations: Conversation[] }>({
    queryKey: ["/api/conversations"],
    enabled: !!userId,
  });

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/messages/unread-count"],
    enabled: !!userId,
    refetchInterval: 30000,
  });

  const conversations = conversationsData?.conversations || [];
  const unreadCount = unreadData?.count || 0;

  const connect = useCallback((token: string) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log("WebSocket connected");
      socket.send(JSON.stringify({ type: "auth", payload: { token } }));
      reconnectAttempts.current = 0;
    };

    socket.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        handleWSMessage(message);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    socket.onclose = () => {
      console.log("WebSocket disconnected");
      setIsConnected(false);
      setWs(null);

      if (reconnectAttempts.current < maxReconnectAttempts) {
        reconnectAttempts.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        setTimeout(() => connect(token), delay);
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    setWs(socket);
  }, []);

  const handleWSMessage = useCallback((message: WSMessage) => {
    switch (message.type) {
      case "auth_success":
        setIsConnected(true);
        break;
      case "auth_error":
        console.error("WebSocket auth failed:", message.payload);
        setIsConnected(false);
        break;
      case "new_message":
      case "message_sent":
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
        queryClient.invalidateQueries({ 
          queryKey: ["/api/conversations", message.payload.conversationId, "messages"] 
        });
        queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
        break;
      case "typing":
        setTypingUsers((prev) => {
          const next = new Map(prev);
          if (message.payload.isTyping) {
            next.set(message.payload.userId, true);
          } else {
            next.delete(message.payload.userId);
          }
          return next;
        });
        break;
      case "messages_read":
      case "messages_read_by_recipient":
        queryClient.invalidateQueries({ queryKey: ["/api/messages/unread-count"] });
        queryClient.invalidateQueries({ 
          queryKey: ["/api/conversations", message.payload.conversationId, "messages"] 
        });
        break;
    }
  }, [queryClient]);

  const disconnect = useCallback(() => {
    if (ws) {
      ws.close();
      setWs(null);
      setIsConnected(false);
    }
  }, [ws]);

  const sendMessage = useCallback((conversationId: string, content: string) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: "send_message",
        payload: { conversationId, content },
      }));
    }
  }, [ws, isConnected]);

  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: "typing",
        payload: { conversationId, isTyping },
      }));
    }
  }, [ws, isConnected]);

  const markAsRead = useCallback((conversationId: string) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify({
        type: "mark_read",
        payload: { conversationId },
      }));
    }
  }, [ws, isConnected]);

  const createConversation = useMutation({
    mutationFn: async (participantId: string) => {
      const res = await apiRequest("POST", "/api/conversations", { participantId });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
  });

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    conversations,
    conversationsLoading,
    unreadCount,
    isConnected,
    typingUsers,
    connect,
    disconnect,
    sendMessage,
    sendTyping,
    markAsRead,
    createConversation,
  };
}

export function useConversationMessages(conversationId: string | null, userId: string | undefined) {
  return useQuery<{ messages: Message[] }>({
    queryKey: ["/api/conversations", conversationId, "messages"],
    queryFn: async () => {
      if (!conversationId) return { messages: [] };
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      return res.json();
    },
    enabled: !!conversationId && !!userId,
  });
}
