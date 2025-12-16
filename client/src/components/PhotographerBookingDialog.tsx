import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Clock, MapPin, Phone, Loader2, ChevronLeft, ChevronRight, Camera, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { PhotographerService, Photographer } from "@shared/schema";

interface PhotographerBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photographerId: string;
  photographerName: string;
  photographerHourlyRate?: number;
}

interface TimeSlot {
  time: string;
  available: boolean;
}

const generateMockSlots = (date: string): TimeSlot[] => {
  const slots: TimeSlot[] = [];
  for (let hour = 9; hour <= 17; hour++) {
    const time = `${hour.toString().padStart(2, "0")}:00`;
    slots.push({ time, available: Math.random() > 0.3 });
  }
  return slots;
};

export default function PhotographerBookingDialog({
  open,
  onOpenChange,
  photographerId,
  photographerName,
  photographerHourlyRate,
}: PhotographerBookingDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [locationDetails, setLocationDetails] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const { data: servicesData, isLoading: servicesLoading } = useQuery<{ services: PhotographerService[] }>({
    queryKey: [`/api/photographers/${photographerId}/services`],
    enabled: open && !!photographerId,
  });

  const services = servicesData?.services || [];
  const selectedService = services.find(s => s.id === selectedServiceId);

  const bookMutation = useMutation({
    mutationFn: async (data: {
      photographerId: string;
      serviceId?: string;
      shootType: string;
      bookingDateTime: string;
      locationDetails: string;
      specialRequests: string;
      totalPriceCents: number;
    }) => {
      const response = await apiRequest("POST", "/api/bookings/photographer", data);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Booking Requested",
        description: "Your photography session has been booked. The photographer will contact you to confirm details.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/bookings"] });
      handleClose();
    },
    onError: () => {
      toast({
        title: "Booking Failed",
        description: "Failed to complete booking. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setStep(1);
    setSelectedServiceId(null);
    setSelectedDate(null);
    setSelectedTime(null);
    setLocationDetails("");
    setSpecialRequests("");
    onOpenChange(false);
  };

  const handleBook = () => {
    if (!selectedDate || !selectedTime || !locationDetails.trim()) return;

    const bookingDateTime = `${selectedDate}T${selectedTime}:00`;
    const shootType = selectedService?.name || "Photography Session";
    
    // Calculate price based on service or hourly rate
    let totalPriceCents = 0;
    if (selectedService) {
      if (selectedService.isContactForPricing) {
        // Contact for pricing - submit as 0 (will be quoted later)
        totalPriceCents = 0;
      } else {
        totalPriceCents = selectedService.priceCents || 0;
      }
    } else if (photographerHourlyRate) {
      // Assume 2-hour minimum session
      totalPriceCents = photographerHourlyRate * 100 * 2;
    }

    bookMutation.mutate({
      photographerId,
      serviceId: selectedServiceId || undefined,
      shootType,
      bookingDateTime,
      locationDetails: locationDetails.trim(),
      specialRequests: specialRequests.trim(),
      totalPriceCents,
    });
  };

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return { firstDay, daysInMonth };
  };

  const { firstDay, daysInMonth } = getDaysInMonth(currentMonth);

  const formatDate = (day: number) => {
    const year = currentMonth.getFullYear();
    const month = String(currentMonth.getMonth() + 1).padStart(2, "0");
    const dayStr = String(day).padStart(2, "0");
    return `${year}-${month}-${dayStr}`;
  };

  const isToday = (day: number) => {
    const today = new Date();
    return (
      day === today.getDate() &&
      currentMonth.getMonth() === today.getMonth() &&
      currentMonth.getFullYear() === today.getFullYear()
    );
  };

  const isPast = (day: number) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
    return checkDate < today;
  };

  const navigateMonth = (direction: number) => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + direction, 1));
    setSelectedDate(null);
    setSelectedTime(null);
  };

  const availableSlots = selectedDate ? generateMockSlots(selectedDate) : [];

  const getServicePriceDisplay = (service: PhotographerService) => {
    if (service.isContactForPricing) {
      return "Contact for pricing";
    }
    if (service.priceCents) {
      return `$${(service.priceCents / 100).toFixed(2)}`;
    }
    return "Price TBD";
  };

  const canProceedToStep2 = selectedServiceId !== null || services.length === 0;
  const canProceedToStep3 = selectedDate !== null && selectedTime !== null;
  const canBook = canProceedToStep3 && locationDetails.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Book {photographerName}</DialogTitle>
          <DialogDescription>
            {step === 1 && "Select a photography service"}
            {step === 2 && "Choose your preferred date and time"}
            {step === 3 && "Add location and special requests"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mb-4">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`flex-1 h-2 rounded-full ${s <= step ? "bg-primary" : "bg-muted"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            {servicesLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : services.length > 0 ? (
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {services.filter(s => s.isActive).map((service) => (
                  <Card
                    key={service.id}
                    className={`cursor-pointer overflow-visible hover-elevate ${
                      selectedServiceId === service.id ? "ring-2 ring-primary" : ""
                    }`}
                    onClick={() => setSelectedServiceId(service.id)}
                    data-testid={`card-service-option-${service.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">{service.name}</p>
                          {service.category && (
                            <Badge variant="outline" className="text-xs mt-1">{service.category}</Badge>
                          )}
                          {service.description && (
                            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{service.description}</p>
                          )}
                          {service.estimatedDurationMinutes && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                              <Clock className="h-3 w-3" />
                              <span>{service.estimatedDurationMinutes} min</span>
                            </div>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          {service.isContactForPricing ? (
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Phone className="h-3 w-3" />
                              <span>Contact for price</span>
                            </div>
                          ) : service.priceCents ? (
                            <span className="font-semibold">${(service.priceCents / 100).toFixed(2)}</span>
                          ) : null}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">No specific services listed</p>
                <p className="text-xs mt-1">You can proceed to book a general photography session</p>
                {photographerHourlyRate && (
                  <p className="text-sm font-medium mt-2">Base rate: ${photographerHourlyRate}/hour</p>
                )}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {selectedService && (
              <div className="p-3 rounded-lg bg-muted/50 flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm">{selectedService.name}</p>
                  {selectedService.estimatedDurationMinutes && (
                    <p className="text-xs text-muted-foreground">{selectedService.estimatedDurationMinutes} min</p>
                  )}
                </div>
                <Badge>{getServicePriceDisplay(selectedService)}</Badge>
              </div>
            )}

            <div className="border rounded-md p-4">
              <div className="flex items-center justify-between mb-4">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => navigateMonth(-1)}
                  data-testid="button-prev-month"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="font-medium" data-testid="text-current-month">
                  {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => navigateMonth(1)}
                  data-testid="button-next-month"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-7 gap-1 text-center text-sm mb-2">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                  <div key={day} className="py-2 text-muted-foreground font-medium">
                    {day}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstDay }).map((_, i) => (
                  <div key={`empty-${i}`} />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const date = formatDate(day);
                  const disabled = isPast(day);
                  const selected = selectedDate === date;

                  return (
                    <Button
                      key={day}
                      variant={selected ? "default" : "ghost"}
                      size="sm"
                      className={`h-10 w-full ${isToday(day) && !selected ? "border border-primary" : ""}`}
                      disabled={disabled}
                      onClick={() => {
                        setSelectedDate(date);
                        setSelectedTime(null);
                      }}
                      data-testid={`button-date-${date}`}
                    >
                      {day}
                    </Button>
                  );
                })}
              </div>
            </div>

            {selectedDate && (
              <div className="space-y-2">
                <h4 className="font-medium text-sm">Select Time</h4>
                <div className="flex flex-wrap gap-2">
                  {availableSlots.map((slot) => (
                    <Button
                      key={slot.time}
                      variant={selectedTime === slot.time ? "default" : "outline"}
                      size="sm"
                      disabled={!slot.available}
                      onClick={() => setSelectedTime(slot.time)}
                      data-testid={`button-time-${slot.time}`}
                    >
                      {slot.time}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-muted/50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{selectedService?.name || "Photography Session"}</span>
                {selectedService && !selectedService.isContactForPricing && selectedService.priceCents && (
                  <Badge>${(selectedService.priceCents / 100).toFixed(2)}</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>
                  {selectedDate && new Date(selectedDate + "T00:00:00").toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  {selectedTime && ` at ${selectedTime}`}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location-details">
                <MapPin className="h-4 w-4 inline mr-1" />
                Shoot Location *
              </Label>
              <Input
                id="location-details"
                placeholder="Enter the address or location for the photoshoot"
                value={locationDetails}
                onChange={(e) => setLocationDetails(e.target.value)}
                data-testid="input-location-details"
              />
              <p className="text-xs text-muted-foreground">
                Provide the full address where the photoshoot will take place
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="special-requests">
                <FileText className="h-4 w-4 inline mr-1" />
                Special Requests / Details
              </Label>
              <Textarea
                id="special-requests"
                placeholder="Describe what you're looking for: style preferences, outfit details, specific shots needed, number of people, etc."
                value={specialRequests}
                onChange={(e) => setSpecialRequests(e.target.value)}
                rows={4}
                data-testid="input-special-requests"
              />
              <p className="text-xs text-muted-foreground">
                Share any details that will help the photographer prepare for your session
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {step > 1 && (
            <Button variant="outline" onClick={() => setStep(step - 1)} data-testid="button-back">
              Back
            </Button>
          )}
          {step === 1 && (
            <Button onClick={() => setStep(2)} disabled={!canProceedToStep2} data-testid="button-next-step-1">
              Continue
            </Button>
          )}
          {step === 2 && (
            <Button onClick={() => setStep(3)} disabled={!canProceedToStep3} data-testid="button-next-step-2">
              Continue
            </Button>
          )}
          {step === 3 && (
            <Button
              onClick={handleBook}
              disabled={!canBook || bookMutation.isPending}
              data-testid="button-confirm-booking"
            >
              {bookMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Booking...
                </>
              ) : selectedService?.isContactForPricing ? (
                "Request Booking"
              ) : (
                "Confirm Booking"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
