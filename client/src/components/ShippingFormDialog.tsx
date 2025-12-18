import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Truck, Package } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { CARRIER_LIST, type CarrierId } from "@shared/carriers";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const shippingFormSchema = z.object({
  carrier: z.string().min(1, "Please select a carrier"),
  trackingNumber: z.string().min(1, "Tracking number is required"),
  notes: z.string().optional(),
  estimatedDelivery: z.string().optional(),
});

type ShippingFormValues = z.infer<typeof shippingFormSchema>;

interface ShippingFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  orderNumber?: string;
  onSuccess?: () => void;
}

export default function ShippingFormDialog({
  open,
  onOpenChange,
  orderId,
  orderNumber,
  onSuccess,
}: ShippingFormDialogProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<ShippingFormValues>({
    resolver: zodResolver(shippingFormSchema),
    defaultValues: {
      carrier: "",
      trackingNumber: "",
      notes: "",
      estimatedDelivery: "",
    },
  });

  const createShipmentMutation = useMutation({
    mutationFn: async (data: ShippingFormValues) => {
      const payload: Record<string, string | undefined> = {
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
        notes: data.notes || undefined,
      };
      
      if (data.estimatedDelivery) {
        payload.estimatedDelivery = new Date(data.estimatedDelivery).toISOString();
      }

      const response = await apiRequest("POST", `/api/orders/${orderId}/shipments`, payload);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Order Marked as Shipped",
        description: "The customer will be notified with the tracking information.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/shipments"] });
      form.reset();
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Create Shipment",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (values: ShippingFormValues) => {
    setIsSubmitting(true);
    createShipmentMutation.mutate(values, {
      onSettled: () => setIsSubmitting(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Mark Order as Shipped
          </DialogTitle>
          <DialogDescription>
            {orderNumber ? (
              <>Enter the shipping details for order <span className="font-mono">{orderNumber}</span></>
            ) : (
              "Enter the carrier and tracking information for this order"
            )}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="carrier"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shipping Carrier</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-carrier">
                        <SelectValue placeholder="Select a carrier" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CARRIER_LIST.map((carrier) => (
                        <SelectItem
                          key={carrier.id}
                          value={carrier.id}
                          data-testid={`option-carrier-${carrier.id}`}
                        >
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4" style={{ color: carrier.color }} />
                            <span>{carrier.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="trackingNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tracking Number</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Enter tracking number"
                      data-testid="input-tracking-number"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="estimatedDelivery"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Estimated Delivery (Optional)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="date"
                      min={new Date().toISOString().split('T')[0]}
                      data-testid="input-estimated-delivery"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Any additional shipping notes..."
                      className="resize-none"
                      rows={2}
                      data-testid="input-shipping-notes"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-shipping"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting || createShipmentMutation.isPending}
                data-testid="button-confirm-shipping"
              >
                {isSubmitting ? "Submitting..." : "Mark as Shipped"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
