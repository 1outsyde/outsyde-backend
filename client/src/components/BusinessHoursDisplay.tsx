import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface DayHours {
  open: string;
  close: string;
  closed?: boolean;
}

export interface HoursOfOperation {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

interface BusinessHoursDisplayProps {
  hours: HoursOfOperation | null | undefined;
  compact?: boolean;
}

const DAYS = [
  { key: "monday", label: "Mon", fullLabel: "Monday" },
  { key: "tuesday", label: "Tue", fullLabel: "Tuesday" },
  { key: "wednesday", label: "Wed", fullLabel: "Wednesday" },
  { key: "thursday", label: "Thu", fullLabel: "Thursday" },
  { key: "friday", label: "Fri", fullLabel: "Friday" },
  { key: "saturday", label: "Sat", fullLabel: "Saturday" },
  { key: "sunday", label: "Sun", fullLabel: "Sunday" },
] as const;

function getCurrentDayKey(): keyof HoursOfOperation {
  const days: (keyof HoursOfOperation)[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return days[new Date().getDay()];
}

function isOpenNow(hours: HoursOfOperation | null | undefined): { isOpen: boolean; nextChange?: string } {
  if (!hours) return { isOpen: false };

  const now = new Date();
  const currentDay = getCurrentDayKey();
  const dayHours = hours[currentDay];

  if (!dayHours || dayHours.closed) {
    return { isOpen: false, nextChange: "Closed today" };
  }

  const currentTimeMinutes = now.getHours() * 60 + now.getMinutes();
  const openMinutes = parseTimeToMinutes(dayHours.open);
  const closeMinutes = parseTimeToMinutes(dayHours.close);

  if (currentTimeMinutes >= openMinutes && currentTimeMinutes < closeMinutes) {
    return { isOpen: true, nextChange: `Closes at ${dayHours.close}` };
  } else if (currentTimeMinutes < openMinutes) {
    return { isOpen: false, nextChange: `Opens at ${dayHours.open}` };
  } else {
    return { isOpen: false, nextChange: "Closed" };
  }
}

function parseTimeToMinutes(time: string): number {
  const match = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return 0;

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3].toUpperCase();

  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

export default function BusinessHoursDisplay({ hours, compact = false }: BusinessHoursDisplayProps) {
  if (!hours) return null;

  const { isOpen, nextChange } = isOpenNow(hours);

  if (compact) {
    return (
      <div className="flex items-center gap-2" data-testid="hours-display-compact">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <Badge variant={isOpen ? "default" : "secondary"} className="text-xs">
          {isOpen ? "Open" : "Closed"}
        </Badge>
        {nextChange && (
          <span className="text-sm text-muted-foreground">{nextChange}</span>
        )}
      </div>
    );
  }

  return (
    <Card className="overflow-visible" data-testid="hours-display-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Business Hours
          </div>
          <Badge variant={isOpen ? "default" : "secondary"}>
            {isOpen ? "Open Now" : "Closed"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {DAYS.map(({ key, fullLabel }) => {
            const dayKey = key as keyof HoursOfOperation;
            const dayHours = hours[dayKey];
            const isToday = dayKey === getCurrentDayKey();

            return (
              <div
                key={key}
                className={`flex items-center justify-between text-sm py-1 ${
                  isToday ? "font-medium" : ""
                }`}
                data-testid={`hours-day-${key}`}
              >
                <span className={isToday ? "text-foreground" : "text-muted-foreground"}>
                  {fullLabel}
                  {isToday && " (Today)"}
                </span>
                <span className={dayHours?.closed ? "text-muted-foreground italic" : ""}>
                  {!dayHours || dayHours.closed ? (
                    "Closed"
                  ) : (
                    `${dayHours.open} - ${dayHours.close}`
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
