import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Store, CheckCircle2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { apiRequest } from "@/lib/queryClient";

interface CheckoutContinuePageProps {
  orderGroupId: string;
  completedOrderId?: string;
  onComplete: () => void;
  onOrderSuccess: (orderGroupId: string) => void;
}

export default function CheckoutContinuePage({ 
  orderGroupId, 
  completedOrderId, 
  onComplete,
  onOrderSuccess 
}: CheckoutContinuePageProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [hasCleanedUrl, setHasCleanedUrl] = useState(false);

  const { data: continueData, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/cart/checkout/continue", orderGroupId, completedOrderId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (completedOrderId) params.set('completedOrderId', completedOrderId);
      const url = `/api/cart/checkout/continue/${orderGroupId}${params.toString() ? `?${params.toString()}` : ''}`;
      const response = await apiRequest("GET", url);
      return response.json();
    },
    enabled: !!orderGroupId,
    refetchOnMount: true,
    staleTime: 0,
  });

  useEffect(() => {
    if (continueData && !hasCleanedUrl) {
      window.history.replaceState({}, "", "/");
      setHasCleanedUrl(true);
    }
  }, [continueData, hasCleanedUrl]);

  useEffect(() => {
    if (continueData?.completed) {
      onOrderSuccess(orderGroupId);
    } else if (continueData?.url && !isRedirecting) {
      setIsRedirecting(true);
      window.location.href = continueData.url;
    }
  }, [continueData, orderGroupId, onOrderSuccess, isRedirecting]);

  if (isLoading || isRedirecting) {
    return (
      <div className="container max-w-md mx-auto px-4 py-16" data-testid="page-checkout-continue">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">
            {isRedirecting ? "Redirecting to payment..." : "Preparing your next checkout..."}
          </h2>
          <p className="text-muted-foreground">
            Please wait while we set up your payment.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container max-w-md mx-auto px-4 py-16" data-testid="page-checkout-continue-error">
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Checkout Error</CardTitle>
            <CardDescription>
              There was a problem continuing your checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={() => refetch()} className="w-full" data-testid="button-retry-checkout">
              Try Again
            </Button>
            <Button variant="outline" onClick={onComplete} className="w-full" data-testid="button-back-to-cart">
              Return to Cart
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (continueData?.completed) {
    return (
      <div className="container max-w-md mx-auto px-4 py-16" data-testid="page-checkout-complete">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2">All payments complete!</h2>
          <p className="text-muted-foreground mb-4">
            Redirecting to your order confirmation...
          </p>
          <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-md mx-auto px-4 py-8" data-testid="page-checkout-continue">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="w-5 h-5" />
            Next Vendor Checkout
          </CardTitle>
          <CardDescription>
            {continueData?.businessName && `Pay for your items from ${continueData.businessName}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {continueData?.remainingVendors !== undefined && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Vendors remaining</span>
                <span>{continueData.remainingVendors}</span>
              </div>
              <Progress 
                value={100 - (continueData.remainingVendors / (continueData.remainingVendors + 1)) * 100} 
                className="h-2"
              />
            </div>
          )}
          
          <Button 
            onClick={() => continueData?.url && (window.location.href = continueData.url)}
            className="w-full gap-2"
            data-testid="button-continue-to-payment"
          >
            Continue to Payment
            <ArrowRight className="w-4 h-4" />
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
