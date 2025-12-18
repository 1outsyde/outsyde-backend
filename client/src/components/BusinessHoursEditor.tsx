import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, Save  } from "lucide-react";
import type { DayHours, HoursOfOperation } from "@shared/schema";

interface BusinessHoursEditorProps {
  hours: HoursOfOperation | null | undefined;
  onSave: (hours: HoursOfOperation) => void;
  isPending?: boolean;
}

const DAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
] as const;

const TIME_OPTIONS = [
  "12:00 AM", "12:30 AM",
  "1:00 AM", "1:30 AM",
  "2:00 AM", "2:30 AM",
  "3:00 AM", "3:30 AM",
  "4:00 AM", "4:30 AM",
  "5:00 AM", "5:30 AM",
  "6:00 AM", "6:30 AM",
  "7:00 AM", "7:30 AM",
  "8:00 AM", "8:30 AM",
  "9:00 AM", "9:30 AM",
  "10:00 AM", "10:30 AM",
  "11:00 AM", "11:30 AM",
  "12:00 PM", "12:30 PM",
  "1:00 PM", "1:30 PM",
  "2:00 PM", "2:30 PM",
  "3:00 PM", "3:30 PM",
  "4:00 PM", "4:30 PM",
  "5:00 PM", "5:30 PM",
  "6:00 PM", "6:30 PM",
  "7:00 PM", "7:30 PM",
  "8:00 PM", "8:30 PM",
  "9:00 PM", "9:30 PM",
  "10:00 PM", "10:30 PM",
  "11:00 PM", "11:30 PM",
];

const DEFAULT_HOURS: DayHours = { open: "9:00 AM", close: "5:00 PM", closed: false };

export default function BusinessHoursEditor({ hours, onSave, isPending }: BusinessHoursEditorProps) {
  const [localHours, setLocalHours] = useState<HoursOfOperation>(() => {
    const defaultHours: HoursOfOperation = {};
    DAYS.forEach(({ key }) => {
      const dayKey = key as keyof HoursOfOperation;
      if (hours?.[dayKey]) {
        defaultHours[dayKey] = hours[dayKey];
      } else {
        defaultHours[dayKey] = key === "saturday" || key === "sunday"
          ? { open: "10:00 AM", close: "4:00 PM", closed: true }
          : { ...DEFAULT_HOURS };
      }
    });
    return defaultHours;
  });

  useEffect(() => {
    if (hours) {
      const updatedHours: HoursOfOperation = {};
      DAYS.forEach(({ key }) => {
        const dayKey = key as keyof HoursOfOperation;
        if (hours[dayKey]) {
          updatedHours[dayKey] = hours[dayKey];
        } else {
          updatedHours[dayKey] = key === "saturday" || key === "sunday"
            ? { open: "10:00 AM", close: "4:00 PM", closed: true }
            : { ...DEFAULT_HOURS };
        }
      });
      setLocalHours(updatedHours);
    }
  }, [hours]);

  const updateDay = (day: keyof HoursOfOperation, field: keyof DayHours, value: string | boolean) => {
    setLocalHours((prev) => ({
      ...prev,
      [day]: {
        ...prev[day],
        [field]: value,
      },
    }));
  };

  const toggleClosed = (day: keyof HoursOfOperation) => {
    const currentClosed = localHours[day]?.closed ?? false;
    updateDay(day, "closed", !currentClosed);
  };

  const handleSave = () => {
    onSave(localHours);
  };

  const copyToAllWeekdays = (sourceDay: keyof HoursOfOperation) => {
    const sourceHours = localHours[sourceDay];
    if (!sourceHours) return;
    
    const weekdays: (keyof HoursOfOperation)[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    setLocalHours((prev) => {
      const updated = { ...prev };
      weekdays.forEach((day) => {
        updated[day] = { ...sourceHours };
      });
      return updated;
    });
  };

  return (
    <Card className="overflow-visible">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Clock className="h-5 w-5" />
          Business Hours
        </CardTitle>
        <CardDescription>
          Set your operating hours for each day of the week
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {DAYS.map(({ key, label }) => {
            const dayKey = key as keyof HoursOfOperation;
            const dayHours = localHours[dayKey] || DEFAULT_HOURS;
            const isClosed = dayHours.closed ?? false;

            return (
              <div
                key={key}
                className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border bg-muted/30"
                data-testid={`hours-row-${key}`}
              >
                <div className="flex items-center justify-between sm:w-32">
                  <Label className="font-medium">{label}</Label>
                  <div className="sm:hidden flex items-center gap-2">
                    <Label htmlFor={`closed-${key}`} className="text-xs text-muted-foreground">
                      {isClosed ? "Closed" : "Open"}
                    </Label>
                    <Switch
                      id={`closed-${key}`}
                      checked={!isClosed}
                      onCheckedChange={() => toggleClosed(dayKey)}
                      data-testid={`switch-${key}-open`}
                    />
                  </div>
                </div>

                <div className="hidden sm:flex items-center gap-2">
                  <Switch
                    id={`closed-desktop-${key}`}
                    checked={!isClosed}
                    onCheckedChange={() => toggleClosed(dayKey)}
                    data-testid={`switch-${key}-open-desktop`}
                  />
                  <Label htmlFor={`closed-desktop-${key}`} className="text-xs text-muted-foreground w-12">
                    {isClosed ? "Closed" : "Open"}
                  </Label>
                </div>

                {!isClosed && (
                  <div className="flex items-center gap-2 flex-1">
                    <Select
                      value={dayHours.open}
                      onValueChange={(val) => updateDay(dayKey, "open", val)}
                    >
                      <SelectTrigger className="w-[120px]" data-testid={`select-${key}-open`}>
                        <SelectValue placeholder="Open" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_OPTIONS.map((time) => (
                          <SelectItem key={time} value={time}>
                            {time}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <span className="text-muted-foreground">to</span>

                    <Select
                      value={dayHours.close}
                      onValueChange={(val) => updateDay(dayKey, "close", val)}
                    >
                      <SelectTrigger className="w-[120px]" data-testid={`select-${key}-close`}>
                        <SelectValue placeholder="Close" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_OPTIONS.map((time) => (
                          <SelectItem key={time} value={time}>
                            {time}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {key === "monday" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-xs ml-auto hidden md:inline-flex"
                        onClick={() => copyToAllWeekdays("monday")}
                        data-testid="button-copy-weekdays"
                      >
                        Copy to weekdays
                      </Button>
                    )}
                  </div>
                )}

                {isClosed && (
                  <div className="flex-1 text-muted-foreground text-sm italic">
                    Closed
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={handleSave} disabled={isPending} data-testid="button-save-hours">
            <Save className="h-4 w-4 mr-2" />
            {isPending ? "Saving..." : "Save Hours"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
