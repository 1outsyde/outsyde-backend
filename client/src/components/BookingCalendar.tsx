import { useState } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface TimeSlot {
  time: string;
  available: boolean;
}

interface BookingCalendarProps {
  serviceName: string;
  servicePrice: number;
  serviceDuration: number;
  availableSlots: Record<string, TimeSlot[]>;
  onBook?: (date: string, time: string) => void;
}

export default function BookingCalendar({
  serviceName,
  servicePrice,
  serviceDuration,
  availableSlots,
  onBook,
}: BookingCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return { firstDay, daysInMonth };
  };

  const { firstDay, daysInMonth } = getDaysInMonth(currentDate);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const formatDate = (day: number) => {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, "0");
    const dayStr = String(day).padStart(2, "0");
    return `${year}-${month}-${dayStr}`;
  };

  const isToday = (day: number) => {
    const today = new Date();
    return (
      day === today.getDate() &&
      currentDate.getMonth() === today.getMonth() &&
      currentDate.getFullYear() === today.getFullYear()
    );
  };

  const isPast = (day: number) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    return checkDate < today;
  };

  const hasSlots = (day: number) => {
    const date = formatDate(day);
    return availableSlots[date]?.some((slot) => slot.available);
  };

  const navigateMonth = (direction: number) => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + direction, 1));
    setSelectedDate(null);
    setSelectedTime(null);
  };

  const handleDateSelect = (day: number) => {
    if (!isPast(day) && hasSlots(day)) {
      setSelectedDate(formatDate(day));
      setSelectedTime(null);
    }
  };

  const slots = selectedDate ? availableSlots[selectedDate] || [] : [];

  return (
    <Card className="overflow-visible p-4" data-testid="booking-calendar">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">{serviceName}</h3>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>{serviceDuration} min</span>
              <span>•</span>
              <span className="font-medium text-foreground">${servicePrice}</span>
            </div>
          </div>
        </div>

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
              {monthNames[currentDate.getMonth()]} {currentDate.getFullYear()}
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
              const disabled = isPast(day) || !hasSlots(day);
              const selected = selectedDate === date;

              return (
                <Button
                  key={day}
                  variant={selected ? "default" : "ghost"}
                  size="sm"
                  className={`h-10 w-full ${isToday(day) && !selected ? "border border-primary" : ""}`}
                  disabled={disabled}
                  onClick={() => handleDateSelect(day)}
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
            <h4 className="font-medium text-sm">Available Times</h4>
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
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

        {selectedDate && selectedTime && (
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm text-muted-foreground">Selected</p>
                <p className="font-medium">
                  {new Date(selectedDate).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  at {selectedTime}
                </p>
              </div>
              <Badge>${servicePrice}</Badge>
            </div>
            <Button
              className="w-full"
              onClick={() => onBook?.(selectedDate, selectedTime)}
              data-testid="button-confirm-booking"
            >
              Confirm Booking
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
