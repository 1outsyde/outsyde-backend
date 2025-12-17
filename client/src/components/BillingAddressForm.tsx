import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, MapPin, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

const billingAddressFormSchema = z.object({
  line1: z.string().min(1, "Address line 1 is required"),
  line2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().min(1, "Postal code is required"),
  country: z.string().min(1, "Country is required"),
});

type BillingAddressFormData = z.infer<typeof billingAddressFormSchema>;

interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

interface BillingAddressFormProps {
  currentAddress?: BillingAddress | null;
  endpoint: string;
  queryKeyToInvalidate: string[];
  title?: string;
}

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
  "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia",
  "Wisconsin", "Wyoming"
];

export default function BillingAddressForm({
  currentAddress,
  endpoint,
  queryKeyToInvalidate,
  title = "Billing Address",
}: BillingAddressFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<BillingAddressFormData>({
    resolver: zodResolver(billingAddressFormSchema),
    defaultValues: {
      line1: currentAddress?.line1 || "",
      line2: currentAddress?.line2 || "",
      city: currentAddress?.city || "",
      state: currentAddress?.state || "",
      postalCode: currentAddress?.postalCode || "",
      country: currentAddress?.country || "United States",
    },
  });

  useEffect(() => {
    if (currentAddress) {
      form.reset({
        line1: currentAddress.line1 || "",
        line2: currentAddress.line2 || "",
        city: currentAddress.city || "",
        state: currentAddress.state || "",
        postalCode: currentAddress.postalCode || "",
        country: currentAddress.country || "United States",
      });
    }
  }, [currentAddress, form]);

  const handleEditClick = () => {
    if (currentAddress) {
      form.reset({
        line1: currentAddress.line1 || "",
        line2: currentAddress.line2 || "",
        city: currentAddress.city || "",
        state: currentAddress.state || "",
        postalCode: currentAddress.postalCode || "",
        country: currentAddress.country || "United States",
      });
    }
    setIsEditing(true);
  };

  const updateMutation = useMutation({
    mutationFn: async (data: BillingAddressFormData) => {
      const response = await apiRequest("PATCH", endpoint, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeyToInvalidate });
      toast({
        title: "Success",
        description: "Billing address updated successfully",
      });
      setIsEditing(false);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update billing address",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: BillingAddressFormData) => {
    updateMutation.mutate(data);
  };

  const hasAddress = currentAddress && currentAddress.line1;

  if (!isEditing && hasAddress) {
    return (
      <Card className="overflow-visible" data-testid="card-billing-address">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">{title}</CardTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEditClick}
            data-testid="button-edit-billing-address"
          >
            Edit
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3">
            <MapPin className="h-4 w-4 text-muted-foreground mt-1" />
            <div className="text-sm" data-testid="text-billing-address">
              <p>{currentAddress.line1}</p>
              {currentAddress.line2 && <p>{currentAddress.line2}</p>}
              <p>
                {currentAddress.city}, {currentAddress.state} {currentAddress.postalCode}
              </p>
              <p>{currentAddress.country}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-visible" data-testid="card-billing-address-form">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
        {hasAddress && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditing(false)}
            data-testid="button-cancel-edit"
          >
            Cancel
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="line1"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address Line 1</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="123 Main Street"
                      {...field}
                      data-testid="input-billing-line1"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="line2"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Address Line 2 (Optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Apt, Suite, Building"
                      {...field}
                      data-testid="input-billing-line2"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="City"
                        {...field}
                        data-testid="input-billing-city"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-billing-state">
                          <SelectValue placeholder="Select state" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {US_STATES.map((state) => (
                          <SelectItem key={state} value={state}>
                            {state}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Postal Code</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="12345"
                        {...field}
                        data-testid="input-billing-postal"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-billing-country">
                          <SelectValue placeholder="Select country" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="United States">United States</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={updateMutation.isPending}
              data-testid="button-save-billing-address"
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Billing Address"
              )}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
