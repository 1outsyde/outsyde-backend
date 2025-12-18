import { Package, ExternalLink, Truck, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { getCarrierConfig, getTrackingUrl, type ShipmentStatus } from "@shared/carriers";

interface Shipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  status: string;
  shippedAt: string;
  deliveredAt: string | null;
  estimatedDelivery: string | null;
}

interface OrderTrackingCardProps {
  orderId: string;
  businessName: string;
  items: string;
  total: number;
  orderStatus: string;
  orderDate: string;
  shipment?: Shipment | null;
}

export default function OrderTrackingCard({
  orderId,
  businessName,
  items,
  total,
  orderStatus,
  orderDate,
  shipment,
}: OrderTrackingCardProps) {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'delivered':
        return <CheckCircle2 className="h-4 w-4 text-green-600" />;
      case 'shipped':
      case 'in_transit':
        return <Truck className="h-4 w-4 text-blue-600" />;
      case 'exception':
        return <AlertCircle className="h-4 w-4 text-red-600" />;
      default:
        return <Clock className="h-4 w-4 text-yellow-600" />;
    }
  };

  const getStatusBadgeVariant = (status: string): "default" | "secondary" | "destructive" => {
    switch (status) {
      case 'delivered':
        return 'default';
      case 'shipped':
      case 'in_transit':
        return 'secondary';
      case 'exception':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const formatStatus = (status: string): string => {
    return status
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <Card className="overflow-visible" data-testid={`card-order-${orderId}`}>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="font-medium truncate" data-testid={`text-business-name-${orderId}`}>
                {businessName}
              </h3>
              <p className="text-sm text-muted-foreground">{items}</p>
              <p className="text-sm font-medium mt-1">${(total / 100).toFixed(2)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Ordered {format(new Date(orderDate), 'MMM d, yyyy')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {getStatusIcon(orderStatus)}
              <Badge variant={getStatusBadgeVariant(orderStatus)}>
                {formatStatus(orderStatus)}
              </Badge>
            </div>
          </div>

          {shipment && (
            <div className="border-t pt-3 mt-1">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  {(() => {
                    const carrier = getCarrierConfig(shipment.carrier);
                    return (
                      <>
                        <div
                          className="flex items-center justify-center h-10 w-10 rounded-md"
                          style={{ backgroundColor: `${carrier.color}15` }}
                        >
                          <Package className="h-5 w-5" style={{ color: carrier.color }} />
                        </div>
                        <div>
                          <p className="text-sm font-medium" data-testid={`text-carrier-${orderId}`}>
                            {carrier.name}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono" data-testid={`text-tracking-${orderId}`}>
                            {shipment.trackingNumber}
                          </p>
                          {shipment.status === 'shipped' && shipment.estimatedDelivery && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Est. delivery: {format(new Date(shipment.estimatedDelivery), 'MMM d, yyyy')}
                            </p>
                          )}
                          {shipment.status === 'delivered' && shipment.deliveredAt && (
                            <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
                              Delivered {format(new Date(shipment.deliveredAt), 'MMM d, yyyy')}
                            </p>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>

                {(() => {
                  const trackingUrl = getTrackingUrl(shipment.carrier, shipment.trackingNumber);
                  if (!trackingUrl) return null;
                  return (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      data-testid={`button-track-${orderId}`}
                    >
                      <a href={trackingUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                        Track Package
                      </a>
                    </Button>
                  );
                })()}
              </div>
            </div>
          )}

          {!shipment && orderStatus !== 'delivered' && orderStatus !== 'cancelled' && (
            <div className="border-t pt-3 mt-1">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Package className="h-4 w-4" />
                <span className="text-sm">Tracking information will appear here once shipped</span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
