import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Package, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest } from "@/lib/queryClient";

interface OrderSuccessPageProps {
  orderId?: string;
  orderGroupId?: string;
  onContinueShopping: () => void;
}

export default function OrderSuccessPage({ orderId, orderGroupId, onContinueShopping }: OrderSuccessPageProps) {
  const [hasCleanedUrl, setHasCleanedUrl] = useState(false);

  const { data: orderGroup, isLoading: groupLoading } = useQuery({
    queryKey: ["/api/order-groups", orderGroupId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/order-groups/${orderGroupId}`);
      return response.json();
    },
    enabled: !!orderGroupId,
  });

  const { data: order, isLoading: orderLoading } = useQuery({
    queryKey: ["/api/orders", orderId],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/orders/${orderId}`);
      return response.json();
    },
    enabled: !!orderId && !orderGroupId,
  });

  const isLoading = groupLoading || orderLoading;

  useEffect(() => {
    if (!isLoading && !hasCleanedUrl) {
      window.history.replaceState({}, "", "/");
      setHasCleanedUrl(true);
    }
  }, [isLoading, hasCleanedUrl]);

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto px-4 py-8" data-testid="page-order-success">
      <div className="text-center mb-8">
        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
          <CheckCircle2 className="w-12 h-12 text-green-600" />
        </div>
        <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="text-order-success-title">
          Order Confirmed!
        </h1>
        <p className="text-muted-foreground" data-testid="text-order-success-message">
          Thank you for your purchase. Your order has been received.
        </p>
      </div>

      {orderGroupId && orderGroup?.orders && (
        <div className="space-y-4 mb-8">
          <h2 className="text-xl font-semibold">Order Summary</h2>
          {orderGroup.orders.map((o: any) => (
            <Card key={o.id} data-testid={`card-order-${o.id}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  {o.businessName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {o.items?.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between text-sm">
                      <span>{item.name} x{item.quantity}</span>
                      <span>{formatCurrency(item.price * item.quantity)}</span>
                    </div>
                  ))}
                  <div className="border-t pt-2 mt-2 flex justify-between font-semibold">
                    <span>Subtotal</span>
                    <span>{formatCurrency(o.totalAmount)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {orderId && order && !orderGroupId && (
        <Card className="mb-8" data-testid={`card-order-${orderId}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5" />
              Order Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {order.items?.map((item: any, idx: number) => (
                <div key={idx} className="flex justify-between text-sm">
                  <span>{item.name} x{item.quantity}</span>
                  <span>{formatCurrency(item.price * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t pt-2 mt-2 flex justify-between font-semibold">
                <span>Total</span>
                <span>{formatCurrency(order.totalAmount)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-4">
          You will receive an email confirmation shortly with your order details.
        </p>
        <Button 
          onClick={onContinueShopping}
          className="gap-2"
          data-testid="button-continue-shopping"
        >
          Continue Shopping
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
