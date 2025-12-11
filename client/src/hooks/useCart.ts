import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient, getQueryFn } from '@/lib/queryClient';
import type { CartItem } from '@shared/schema';

interface CartResponse {
  items: CartItem[];
  itemCount: number;
  totalCents: number;
  totalFormatted: string;
}

interface AddToCartParams {
  productId: string;
  productName: string;
  productImage?: string;
  priceInCents: number;
  quantity?: number;
  businessId?: string;
  businessName?: string;
}

export function useCart() {
  const { data: cartData, isLoading, error } = useQuery<CartResponse>({
    queryKey: ['/api/cart'],
    queryFn: getQueryFn({ on401: 'returnNull' }),
    staleTime: 30000,
  });

  const addMutation = useMutation({
    mutationFn: async (item: AddToCartParams) => {
      const response = await apiRequest('POST', '/api/cart/add', item);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/cart'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, quantity }: { id: string; quantity: number }) => {
      const response = await apiRequest('PATCH', `/api/cart/${id}`, { quantity });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/cart'] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest('DELETE', `/api/cart/${id}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/cart'] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('DELETE', '/api/cart');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/cart'] });
    },
  });

  return {
    items: cartData?.items ?? [],
    itemCount: cartData?.itemCount ?? 0,
    totalCents: cartData?.totalCents ?? 0,
    totalFormatted: cartData?.totalFormatted ?? '$0.00',
    isLoading,
    error,
    addToCart: addMutation.mutate,
    updateQuantity: (id: string, quantity: number) => updateMutation.mutate({ id, quantity }),
    removeItem: removeMutation.mutate,
    clearCart: clearMutation.mutate,
    isAddingToCart: addMutation.isPending,
    isUpdating: updateMutation.isPending,
    isRemoving: removeMutation.isPending,
    isClearing: clearMutation.isPending,
  };
}
