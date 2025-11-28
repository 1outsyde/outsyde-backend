import BookingCalendar from "../BookingCalendar";

export default function BookingCalendarExample() {
  const today = new Date();
  const formatDate = (offset: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  };

  const availableSlots = {
    [formatDate(0)]: [
      { time: "9:00 AM", available: true },
      { time: "10:00 AM", available: false },
      { time: "11:00 AM", available: true },
      { time: "2:00 PM", available: true },
      { time: "3:00 PM", available: true },
    ],
    [formatDate(1)]: [
      { time: "9:00 AM", available: true },
      { time: "10:00 AM", available: true },
      { time: "11:00 AM", available: true },
      { time: "1:00 PM", available: true },
    ],
    [formatDate(2)]: [
      { time: "10:00 AM", available: true },
      { time: "2:00 PM", available: true },
      { time: "4:00 PM", available: true },
    ],
    [formatDate(4)]: [
      { time: "9:00 AM", available: true },
      { time: "11:00 AM", available: true },
    ],
  };

  return (
    <div className="max-w-md">
      <BookingCalendar
        serviceName="Full Hair Styling Session"
        servicePrice={85}
        serviceDuration={60}
        availableSlots={availableSlots}
        onBook={(date, time) => console.log("Booked:", date, time)}
      />
    </div>
  );
}
