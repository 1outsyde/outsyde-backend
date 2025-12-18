import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, parseISO } from "date-fns";
import { Calendar, Plus, ChevronLeft, ChevronRight, Clock, Trash2, Edit2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { BusinessAvailability } from "@shared/schema";

interface SlotFormData {
  date: string;
  startTime: string;
  endTime: string;
  slotType: "available" | "blocked" | "special";
  title: string;
  notes: string;
}

const defaultSlotData: SlotFormData = {
  date: format(new Date(), "yyyy-MM-dd"),
  startTime: "09:00",
  endTime: "17:00",
  slotType: "available",
  title: "",
  notes: "",
};

export default function AvailabilityCalendar() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<BusinessAvailability | null>(null);
  const [slotData, setSlotData] = useState<SlotFormData>(defaultSlotData);
  const { toast } = useToast();

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
    setSlotData({
      ...defaultSlotData,
      date: date ? format(date, "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"),
    });
    setDialogOpen(true);
  };

  const openEditDialog = (slot: BusinessAvailability) => {
    setEditingSlot(slot);
    setSlotData({
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
    setSlotData(defaultSlotData);
  };

  const handleSubmit = () => {
    if (!slotData.date || !slotData.startTime || !slotData.endTime) {
      toast({ title: "Missing fields", description: "Please fill in date, start time, and end time.", variant: "destructive" });
      return;
    }

    if (editingSlot) {
      updateMutation.mutate({ id: editingSlot.id, data: slotData });
    } else {
      createMutation.mutate(slotData);
    }
  };

  const handleDelete = (slotId: string) => {
    deleteMutation.mutate(slotId);
  };

  const getSlotTypeColor = (slotType: string) => {
    switch (slotType) {
      case "available": return "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700";
      case "blocked": return "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700";
      case "special": return "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700";
      default: return "bg-muted";
    }
  };

  const getSlotTypeBadge = (slotType: string) => {
    switch (slotType) {
      case "available": return <Badge variant="outline" className="bg-green-50 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300">Available</Badge>;
      case "blocked": return <Badge variant="outline" className="bg-red-50 dark:bg-red-900/50 text-red-700 dark:text-red-300 border-red-300">Blocked</Badge>;
      case "special": return <Badge variant="outline" className="bg-amber-50 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border-amber-300">Special</Badge>;
      default: return <Badge variant="outline">Unknown</Badge>;
    }
  };

  const selectedDateSlots = selectedDate ? getSlotsForDate(selectedDate) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Calendar className="h-8 w-8 text-muted-foreground" />
          <div>
            <h2 className="text-xl font-semibold" data-testid="heading-availability">Availability Calendar</h2>
            <p className="text-muted-foreground">Manage your bookable time slots</p>
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
            <CardTitle>{format(currentMonth, "MMMM yyyy")}</CardTitle>
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
                <div key={day} className="text-center text-sm font-medium text-muted-foreground py-2">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
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
                    data-testid={`calendar-day-${format(day, "yyyy-MM-dd")}`}
                  >
                    <span className={isToday ? "text-primary" : ""}>{format(day, "d")}</span>
                    {daySlots.length > 0 && (
                      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5">
                        {hasAvailable && <div className="w-1.5 h-1.5 rounded-full bg-green-500" />}
                        {hasBlocked && <div className="w-1.5 h-1.5 rounded-full bg-red-500" />}
                        {hasSpecial && <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
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
            <CardTitle className="text-base">
              {selectedDate ? format(selectedDate, "EEEE, MMMM d, yyyy") : "Select a date"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDate ? (
              <div className="space-y-3">
                {selectedDateSlots.length === 0 ? (
                  <div className="text-center py-8">
                    <Clock className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-muted-foreground mb-4">No time slots for this date</p>
                    <Button variant="outline" size="sm" onClick={() => openNewSlotDialog(selectedDate)} data-testid="button-add-slot-for-date">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Slot
                    </Button>
                  </div>
                ) : (
                  <>
                    {selectedDateSlots.map(slot => (
                      <div key={slot.id} className={`p-3 rounded-lg border ${getSlotTypeColor(slot.slotType || "available")}`} data-testid={`slot-${slot.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              {getSlotTypeBadge(slot.slotType || "available")}
                            </div>
                            <p className="font-medium text-sm">
                              {slot.startTime} - {slot.endTime}
                            </p>
                            {slot.title && <p className="text-sm text-muted-foreground mt-1">{slot.title}</p>}
                            {slot.notes && <p className="text-xs text-muted-foreground mt-1">{slot.notes}</p>}
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
              <div className="text-center py-8">
                <Calendar className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">Click on a date to view or manage time slots</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500" />
              <span className="text-sm">Available - Open for bookings</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              <span className="text-sm">Blocked - Not accepting bookings</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-amber-500" />
              <span className="text-sm">Special - Custom hours or event</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSlot ? "Edit Time Slot" : "Add Time Slot"}</DialogTitle>
            <DialogDescription>
              {editingSlot ? "Update your availability for this time slot." : "Create a new availability slot for customers to book."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={slotData.date}
                onChange={(e) => setSlotData({ ...slotData, date: e.target.value })}
                data-testid="input-slot-date"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startTime">Start Time</Label>
                <Input
                  id="startTime"
                  type="time"
                  value={slotData.startTime}
                  onChange={(e) => setSlotData({ ...slotData, startTime: e.target.value })}
                  data-testid="input-slot-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endTime">End Time</Label>
                <Input
                  id="endTime"
                  type="time"
                  value={slotData.endTime}
                  onChange={(e) => setSlotData({ ...slotData, endTime: e.target.value })}
                  data-testid="input-slot-end-time"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="slotType">Slot Type</Label>
              <Select value={slotData.slotType} onValueChange={(value: "available" | "blocked" | "special") => setSlotData({ ...slotData, slotType: value })}>
                <SelectTrigger data-testid="select-slot-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                  <SelectItem value="special">Special</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">Title (optional)</Label>
              <Input
                id="title"
                placeholder="e.g., Morning Appointments, Lunch Break"
                value={slotData.title}
                onChange={(e) => setSlotData({ ...slotData, title: e.target.value })}
                data-testid="input-slot-title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea
                id="notes"
                placeholder="Any additional notes about this time slot"
                value={slotData.notes}
                onChange={(e) => setSlotData({ ...slotData, notes: e.target.value })}
                data-testid="input-slot-notes"
              />
            </div>
          </div>
          <DialogFooter className="flex gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeDialog} data-testid="button-cancel-slot">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending} data-testid="button-save-slot">
              {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingSlot ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
