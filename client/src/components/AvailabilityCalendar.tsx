import { useState, useEffect } from "react";
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
import type { BusinessAvailability } from "@shared/schema";

const slotFormSchema = z.object({
  date: z.string().min(1, "Date is required"),
  startTime: z.string().min(1, "Start time is required"),
  endTime: z.string().min(1, "End time is required"),
  slotType: z.enum(["available", "blocked", "special"]),
  title: z.string().optional(),
  notes: z.string().optional(),
});

type SlotFormData = z.infer<typeof slotFormSchema>;

export default function AvailabilityCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<BusinessAvailability | null>(null);
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

  const { data: availabilityData, isLoading } = useQuery<{ availability: BusinessAvailability[] }>({
    queryKey: ["/api/vendor/availability", startDate, endDate],
    queryFn: async () => {
      const response = await fetch(`/api/vendor/availability?startDate=${startDate}&endDate=${endDate}`);
      if (!response.ok) throw new Error("Failed to fetch availability");
      return response.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: SlotFormData) => {
      const response = await apiRequest("POST", "/api/vendor/availability", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability slot created", description: "Your schedule has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/availability"] });
      closeDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create availability slot.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<SlotFormData> }) => {
      const response = await apiRequest("PATCH", `/api/vendor/availability/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability updated", description: "Your schedule has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/availability"] });
      closeDialog();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update availability.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/vendor/availability/${id}`);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Availability removed", description: "The time slot has been deleted." });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor/availability"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete availability.", variant: "destructive" });
    },
  });

  const availability = availabilityData?.availability || [];
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

  const openEditDialog = (slot: BusinessAvailability) => {
    setEditingSlot(slot);
    form.reset({
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      slotType: (slot.slotType as "available" | "blocked" | "special") || "available",
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

  const handleDelete = (slotId: string) => {
    deleteMutation.mutate(slotId);
  };

  const getSlotTypeColor = (slotType: string) => {
    switch (slotType) {
      case "available": return "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700";
      case "blocked": return "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700";
      case "booked": return "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700";
      case "special": return "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700";
      default: return "bg-muted";
    }
  };

  const getSlotTypeBadge = (slotType: string) => {
    switch (slotType) {
      case "available": return <Badge variant="outline" className="bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300" data-testid="badge-available">Available</Badge>;
      case "blocked": return <Badge variant="outline" className="bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border-red-300" data-testid="badge-blocked">Blocked</Badge>;
      case "booked": return <Badge variant="outline" className="bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-blue-300" data-testid="badge-booked">Booked</Badge>;
      case "special": return <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border-amber-300" data-testid="badge-special">Special</Badge>;
      default: return <Badge variant="outline" data-testid="badge-unknown">Unknown</Badge>;
    }
  };

  const isBookedSlot = (slot: BusinessAvailability) => slot.slotType === "booked";

  const selectedDateSlots = selectedDate ? getSlotsForDate(selectedDate) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Calendar className="h-8 w-8 text-muted-foreground" />
          <div>
            <h2 className="text-xl font-semibold" data-testid="heading-availability">Availability Calendar</h2>
            <p className="text-muted-foreground" data-testid="text-availability-description">Manage your bookable time slots</p>
          </div>
        </div>
        <Button onClick={() => openNewSlotDialog()} data-testid="button-add-availability">
          <Plus className="h-4 w-4 mr-2" />
          Add Time Slot
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-4">
            <CardTitle data-testid="text-current-month">{format(currentMonth, "MMMM yyyy")}</CardTitle>
            <div className="flex gap-1">
              <Button variant="outline" size="icon" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-1 mb-2">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => (
                <div key={day} className="text-center text-sm font-medium text-muted-foreground py-2" data-testid={`text-day-header-${day.toLowerCase()}`}>
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1" data-testid="calendar-grid">
              {paddingDays.map(i => (
                <div key={`pad-${i}`} className="aspect-square" />
              ))}
              {daysInMonth.map(day => {
                const daySlots = getSlotsForDate(day);
                const isSelected = selectedDate && isSameDay(day, selectedDate);
                const isToday = isSameDay(day, new Date());
                const hasAvailable = daySlots.some(s => s.slotType === "available");
                const hasBlocked = daySlots.some(s => s.slotType === "blocked");
                const hasSpecial = daySlots.some(s => s.slotType === "special");

                return (
                  <button
                    key={day.toISOString()}
                    onClick={() => setSelectedDate(day)}
                    className={`aspect-square p-1 rounded-md text-sm relative transition-colors
                      ${isSelected ? "ring-2 ring-primary" : ""}
                      ${isToday ? "bg-primary/10 font-bold" : "hover-elevate"}
                    `}
                    data-testid={`button-calendar-day-${format(day, "yyyy-MM-dd")}`}
                  >
                    <span className={isToday ? "text-primary" : ""} data-testid={`text-day-${format(day, "d")}`}>{format(day, "d")}</span>
                    {daySlots.length > 0 && (
                      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5" data-testid={`indicators-${format(day, "yyyy-MM-dd")}`}>
                        {hasAvailable && <div className="w-1.5 h-1.5 rounded-full bg-green-500" data-testid="indicator-available" />}
                        {hasBlocked && <div className="w-1.5 h-1.5 rounded-full bg-red-500" data-testid="indicator-blocked" />}
                        {hasSpecial && <div className="w-1.5 h-1.5 rounded-full bg-amber-500" data-testid="indicator-special" />}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base" data-testid="text-selected-date">
              {selectedDate ? format(selectedDate, "EEEE, MMMM d, yyyy") : "Select a date"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate ? (
              <div className="space-y-3" data-testid="slots-list">
                {selectedDateSlots.length === 0 ? (
                  <div className="text-center py-8" data-testid="empty-slots-state">
                    <Clock className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-muted-foreground mb-4" data-testid="text-no-slots">No time slots for this date</p>
                    <Button variant="outline" size="sm" onClick={() => openNewSlotDialog(selectedDate)} data-testid="button-add-slot-for-date">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Slot
                    </Button>
                  </div>
                ) : (
                  <>
                    {selectedDateSlots.map(slot => (
                      <div key={slot.id} className={`p-3 rounded-lg border ${getSlotTypeColor(slot.slotType || "available")}`} data-testid={`slot-card-${slot.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              {getSlotTypeBadge(slot.slotType || "available")}
                            </div>
                            <p className="font-medium text-sm" data-testid={`text-slot-time-${slot.id}`}>
                              {slot.startTime} - {slot.endTime}
                            </p>
                            {slot.title && <p className="text-sm text-muted-foreground mt-1" data-testid={`text-slot-title-${slot.id}`}>{slot.title}</p>}
                            {slot.notes && <p className="text-xs text-muted-foreground mt-1" data-testid={`text-slot-notes-${slot.id}`}>{slot.notes}</p>}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button variant="ghost" size="icon" onClick={() => openEditDialog(slot)} data-testid={`button-edit-slot-${slot.id}`}>
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDelete(slot.id)} data-testid={`button-delete-slot-${slot.id}`}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" className="w-full" onClick={() => openNewSlotDialog(selectedDate)} data-testid="button-add-another-slot">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Another Slot
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="text-center py-8" data-testid="no-date-selected-state">
                <Calendar className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground" data-testid="text-select-date-prompt">Click on a date to view or manage time slots</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-legend">
        <CardHeader className="pb-2">
          <CardTitle className="text-base" data-testid="heading-legend">Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4" data-testid="legend-items">
            <div className="flex items-center gap-2" data-testid="legend-available">
              <div className="w-3 h-3 rounded-full bg-green-500" />
              <span className="text-sm">Available - Open for bookings</span>
            </div>
            <div className="flex items-center gap-2" data-testid="legend-blocked">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="text-sm">Blocked - Not accepting bookings</span>
            </div>
            <div className="flex items-center gap-2" data-testid="legend-special">
              <div className="w-3 h-3 rounded-full bg-amber-500" />
              <span className="text-sm">Special - Custom hours or event</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="dialog-slot-form">
          <DialogHeader>
            <DialogTitle data-testid="text-dialog-title">{editingSlot ? "Edit Time Slot" : "Add Time Slot"}</DialogTitle>
            <DialogDescription data-testid="text-dialog-description">
              {editingSlot ? "Update your availability for this time slot." : "Create a new availability slot for customers to book."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4" data-testid="form-slot">
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
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-slot-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="available" data-testid="option-available">Available</SelectItem>
                        <SelectItem value="blocked" data-testid="option-blocked">Blocked</SelectItem>
                        <SelectItem value="special" data-testid="option-special">Special</SelectItem>
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
                    <FormLabel>Title (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Morning Appointments, Lunch Break" {...field} data-testid="input-slot-title" />
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
                    <FormLabel>Notes (optional)</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Any additional notes about this time slot" {...field} data-testid="input-slot-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter className="flex gap-2 sm:gap-0">
                <Button type="button" variant="outline" onClick={closeDialog} data-testid="button-cancel-slot">
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending} data-testid="button-save-slot">
                  {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingSlot ? "Update" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
