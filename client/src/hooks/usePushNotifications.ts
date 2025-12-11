import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';

interface PushSubscriptionState {
  isSupported: boolean;
  isSubscribed: boolean;
  permission: NotificationPermission;
  isLoading: boolean;
  error: string | null;
}

export function usePushNotifications() {
  const [state, setState] = useState<PushSubscriptionState>({
    isSupported: false,
    isSubscribed: false,
    permission: 'default',
    isLoading: true,
    error: null,
  });

  const { data: vapidData } = useQuery<{ publicKey: string; configured: boolean }>({
    queryKey: ['/api/push/vapid-key'],
  });

  useEffect(() => {
    async function checkSubscription() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setState(s => ({ ...s, isSupported: false, isLoading: false }));
        return;
      }

      setState(s => ({ ...s, isSupported: true, permission: Notification.permission }));

      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        setState(s => ({ 
          ...s, 
          isSubscribed: !!subscription, 
          isLoading: false 
        }));
      } catch (error) {
        setState(s => ({ ...s, isLoading: false, error: 'Failed to check subscription' }));
      }
    }

    checkSubscription();
  }, []);

  const registerServiceWorker = useCallback(async () => {
    if (!('serviceWorker' in navigator)) return null;
    
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return registration;
    } catch (error) {
      console.error('Service worker registration failed:', error);
      return null;
    }
  }, []);

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      if (!vapidData?.publicKey || !vapidData.configured) {
        throw new Error('Push notifications not configured');
      }

      const permission = await Notification.requestPermission();
      setState(s => ({ ...s, permission }));

      if (permission !== 'granted') {
        throw new Error('Notification permission denied');
      }

      const registration = await registerServiceWorker();
      if (!registration) {
        throw new Error('Service worker registration failed');
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey),
      });

      const response = await apiRequest('POST', '/api/push/subscribe', subscription.toJSON());
      return response.json();
    },
    onSuccess: () => {
      setState(s => ({ ...s, isSubscribed: true, error: null }));
    },
    onError: (error: Error) => {
      setState(s => ({ ...s, error: error.message }));
    },
  });

  const unsubscribeMutation = useMutation({
    mutationFn: async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        await subscription.unsubscribe();
        await apiRequest('DELETE', '/api/push/unsubscribe', {
          endpoint: subscription.endpoint,
        });
      }
    },
    onSuccess: () => {
      setState(s => ({ ...s, isSubscribed: false, error: null }));
    },
    onError: (error: Error) => {
      setState(s => ({ ...s, error: error.message }));
    },
  });

  const subscribe = useCallback(() => {
    subscribeMutation.mutate();
  }, [subscribeMutation]);

  const unsubscribe = useCallback(() => {
    unsubscribeMutation.mutate();
  }, [unsubscribeMutation]);

  return {
    ...state,
    subscribe,
    unsubscribe,
    isSubscribing: subscribeMutation.isPending,
    isUnsubscribing: unsubscribeMutation.isPending,
    configured: vapidData?.configured ?? false,
  };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
