import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, addMonths, subMonths } from "date-fns";
import { Calendar, Plus, ChevronLeft, ChevronRight, Clock, Trash2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import type { PhotographerAvailability } from "@shared/schema";

const slotFormSchema = z.object({
  date: z.string().min(1, "Date is required"),
  startTime: z.string().min(1, "Start time is required"),
  endTime: z.string().min(1, "End time is required"),
  slotType: z.enum(["available", "blocked", "booked"]),
  title: z.string().optional(),
  notes: z.string().optional(),
});

type SlotFormData = z.infer<typeof slotFormSchema>;

export default function PhotographerAvailabilityCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<PhotographerAvailability | null>(null);
  const { toast } = useToast();

  const form = useForm<SlotFormData>({
    resolver: zodResolver(slotFormSchema),
    defaultValues: {
      date: format(new Date(), "yyyy-MM-dd"),
      startTime: "09:00",
      endTime: "17:00",
      slotType: "available",
      title: "",
      notes: "",
    },
  });

  const startDate = format(startOfMonth(currentMonth), "yyyy-MM-dd");
  const endDate = format(endOfMonth(currentMonth), "yyyy-MM-dd");

  const { data: availabilityData, isLoading } = useQuery<{ slots: PhotographerAvailability[] }>({
    queryKey: ["/api/photographers/me/availability", startDate, endDate],
    queryFn: async () => {
      const response = await fetch(`/api/photographers/me/availability?startDate=${startDate}&endDate=${endDate}`);
      if (!response.ok) throw new Error("Failed to fetch availability");
      return response.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: SlotFormData) => {
      const response = await apiRequest("POST", "/api/photographers/me/availability", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability slot created", description: "Your schedule has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/availability"] });
      closeDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create availability slot.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<SlotFormData> }) => {
      const response = await apiRequest("PATCH", `/api/photographers/me/availability/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability updated", description: "Your schedule has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/availability"] });
      closeDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update availability.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/photographers/me/availability/${id}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability removed", description: "The time slot has been deleted." });
      queryClient.invalidateQueries({ queryKey: ["/api/photographers/me/availability"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete availability.", variant: "destructive" });
    },
  });

  const availability = availabilityData?.slots || [];
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const firstDayOfWeek = monthStart.getDay();
  const paddingDays = Array.from({ length: firstDayOfWeek }, (_, i) => i);

  const getSlotsForDate = (date: Date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    return availability.filter(slot => slot.date === dateStr);
  };

  const openNewSlotDialog = (date?: Date) => {
    setEditingSlot(null);
    form.reset({
      date: date ? format(date, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"),
      startTime: "09:00",
      endTime: "17:00",
      slotType: "available",
      title: "",
      notes: "",
    });
    setDialogOpen(true);
  };

  const openEditDialog = (slot: PhotographerAvailability) => {
    if (slot.slotType === "booked") {
      toast({ title: "Cannot edit", description: "Booked slots cannot be modified.", variant: "destructive" });
      return;
    }
    setEditingSlot(slot);
    form.reset({
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      slotType: (slot.slotType as "available" | "blocked" | "booked") || "available",
      title: slot.title || "",
      notes: slot.notes || "",
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingSlot(null);
    form.reset();
  };

  const onSubmit = (data: SlotFormData) => {
    if (editingSlot) {
      updateMutation.mutate({ id: editingSlot.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleDelete = (slot: PhotographerAvailability) => {
    if (slot.slotType === "booked") {
      toast({ title: "Cannot delete", description: "Booked slots cannot be deleted.", variant: "destructive" });
      return;
    }
    deleteMutation.mutate(slot.id);
  };

  const getSlotTypeColor = (slotType: string) => {
    switch (slotType) {
      case "available": return "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700";
      case "blocked": return "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700";
      case "booked": return "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";
      default: return "bg-muted";
    }
  };

  const getSlotTypeBadge = (slotType: string) => {
    switch (slotType) {
      case "available": return <Badge variant="outline" className="bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300" data-testid="badge-available">Available</Badge>;
      case "blocked": return <Badge variant="outline" className="bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border-red-300" data-testid="badge-blocked">Blocked</Badge>;
      case "booked": return <Badge variant="outline" className="bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-blue-300" data-testid="badge-booked">Booked</Badge>;
      default: return <Badge variant="outline" data-testid="badge-unknown">Unknown</Badge>;
    }
  };

  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <Card data-testid="photographer-availability-calendar">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-4">
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          Availability Calendar
        </CardTitle>
        <Button onClick={() => openNewSlotDialog()} size="sm" data-testid="button-add-availability">
          <Plus className="h-4 w-4 mr-1" />
          Add Slot
        </Button>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-4">
          <Button variant="ghost" size="icon" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} data-testid="button-prev-month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h3 className="font-semibold text-lg" data-testid="text-current-month">{format(currentMonth, "MMMM yyyy")}</h3>
          <Button variant="ghost" size="icon" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} data-testid="button-next-month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-1 mb-2">
          {weekDays.map((day) => (
            <div key={day} className="text-center text-sm font-medium text-muted-foreground py-2">
              {day}
            </div>
          ))}
        </div>

        {isLoading ? (
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="aspect-square bg-muted animate-pulse rounded-md" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {paddingDays.map((i) => (
              <div key={`padding-${i}`} className="aspect-square" />
            ))}
            {daysInMonth.map((day) => {
              const slots = getSlotsForDate(day);
              const isToday = isSameDay(day, new Date());
              const isSelected = selectedDate && isSameDay(day, selectedDate);
              const hasBookedSlot = slots.some(s => s.slotType === "booked");
              const hasBlockedSlot = slots.some(s => s.slotType === "blocked");
              const hasAvailableSlot = slots.some(s => s.slotType === "available");

              return (
                <button
                  key={day.toISOString()}
                  onClick={() => setSelectedDate(day)}
                  className={`aspect-square p-1 rounded-md border transition-colors hover-elevate ${
                    isSelected ? "ring-2 ring-primary" : ""
                  } ${isToday ? "border-primary" : "border-border"} ${
                    hasBookedSlot ? "bg-blue-50 dark:bg-blue-900/20" : 
                    hasBlockedSlot ? "bg-red-50 dark:bg-red-900/20" :
                    hasAvailableSlot ? "bg-green-50 dark:bg-green-900/20" : "bg-card"
                  }`}
                  data-testid={`calendar-day-${format(day, "yyyy-MM-dd")}`}
                >
                  <div className="text-sm font-medium">{format(day, "d")}</div>
                  {slots.length > 0 && (
                    <div className="flex flex-wrap gap-0.5 mt-1 justify-center">
                      {slots.slice(0, 3).map((slot) => (
                        <div
                          key={slot.id}
                          className={`w-1.5 h-1.5 rounded-full ${
                            slot.slotType === "available" ? "bg-green-500" :
                            slot.slotType === "blocked" ? "bg-red-500" :
                            slot.slotType === "booked" ? "bg-blue-500" : "bg-gray-500"
                          }`}
                        />
                      ))}
                      {slots.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">+{slots.length - 3}</span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {selectedDate && (
          <div className="mt-4 border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold" data-testid="text-selected-date">{format(selectedDate, "EEEE, MMMM d, yyyy")}</h4>
              <Button variant="outline" size="sm" onClick={() => openNewSlotDialog(selectedDate)} data-testid="button-add-slot-date">
                <Plus className="h-4 w-4 mr-1" />
                Add Slot
              </Button>
            </div>
            <div className="space-y-2">
              {getSlotsForDate(selectedDate).length === 0 ? (
                <p className="text-sm text-muted-foreground">No availability slots for this date.</p>
              ) : (
                getSlotsForDate(selectedDate).map((slot) => (
                  <div
                    key={slot.id}
                    className={`p-3 rounded-md border ${getSlotTypeColor(slot.slotType || "available")}`}
                    data-testid={`slot-${slot.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{slot.startTime} - {slot.endTime}</span>
                        {getSlotTypeBadge(slot.slotType || "available")}
                      </div>
                      {slot.slotType !== "booked" && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(slot)}
                            data-testid={`button-edit-slot-${slot.id}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(slot)}
                            data-testid={`button-delete-slot-${slot.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </div>
                    {slot.title && <p className="text-sm mt-1 font-medium">{slot.title}</p>}
                    {slot.notes && <p className="text-sm text-muted-foreground mt-1">{slot.notes}</p>}
                    {slot.shootBookingId && (
                      <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                        Linked to booking
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSlot ? "Edit Availability Slot" : "Add Availability Slot"}</DialogTitle>
            <DialogDescription>
              {editingSlot ? "Update your availability details." : "Add a new availability slot to your schedule."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-slot-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start Time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} data-testid="input-slot-start-time" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>End Time</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} data-testid="input-slot-end-time" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="slotType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slot Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-slot-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="available">Available</SelectItem>
                        <SelectItem value="blocked">Blocked</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Morning sessions" {...field} data-testid="input-slot-title" />
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
                      <Textarea placeholder="Any additional details..." {...field} data-testid="input-slot-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeDialog} data-testid="button-cancel-slot">
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={createMutation.isPending || updateMutation.isPending}
                  data-testid="button-save-slot"
                >
                  {createMutation.isPending || updateMutation.isPending ? "Saving..." : (editingSlot ? "Update" : "Create")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
