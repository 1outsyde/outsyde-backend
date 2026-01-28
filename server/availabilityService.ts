import { db } from "./db";
import { 
  staffAvailability, 
  staffMembers,
  appointments, 
  photographerAvailability,
  photographerBlackoutDates,
  shootBookings,
  vendorServices,
  photographerServices,
  businesses,
  photographers,
  weeklyAvailability,
  providerBlocks,
  BOOKING_STATES
} from "@shared/schema";
import { eq, and, or, gte, lte, inArray, ne, sql, isNull } from "drizzle-orm";

export interface TimeSlot {
  startTime: string;
  endTime: string;
  available: boolean;
  reason?: 'booked' | 'blocked' | 'outside_hours' | 'draft_locked';
}

export interface DayAvailability {
  date: string;
  slots: TimeSlot[];
  totalAvailable: number;
}

export interface StaffAvailabilityResult {
  staffMemberId: string;
  staffName: string;
  businessId: string;
  availability: DayAvailability[];
}

export interface PhotographerAvailabilityResult {
  photographerId: string;
  photographerName: string;
  availability: DayAvailability[];
}

const SLOT_DURATION_MINUTES = 30;

function generateTimeSlots(startHour: number, endHour: number, slotMinutes: number = SLOT_DURATION_MINUTES): { start: string; end: string }[] {
  const slots: { start: string; end: string }[] = [];
  let currentMinutes = startHour * 60;
  const endMinutes = endHour * 60;

  while (currentMinutes + slotMinutes <= endMinutes) {
    const startH = Math.floor(currentMinutes / 60);
    const startM = currentMinutes % 60;
    const endCurrentMinutes = currentMinutes + slotMinutes;
    const endH = Math.floor(endCurrentMinutes / 60);
    const endM = endCurrentMinutes % 60;

    slots.push({
      start: `${startH.toString().padStart(2, '0')}:${startM.toString().padStart(2, '0')}`,
      end: `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`,
    });

    currentMinutes += slotMinutes;
  }

  return slots;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function doTimesOverlap(
  start1: string, end1: string,
  start2: string, end2: string
): boolean {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && e1 > s2;
}

async function getWeeklyAvailabilityForDay(
  providerType: string,
  providerId: string,
  dayOfWeek: number,
  staffMemberId?: string
): Promise<{ startTime: string; endTime: string }[]> {
  const conditions = [
    eq(weeklyAvailability.providerType, providerType),
    eq(weeklyAvailability.providerId, providerId),
    eq(weeklyAvailability.dayOfWeek, dayOfWeek),
    eq(weeklyAvailability.isActive, true),
  ];
  
  if (staffMemberId) {
    conditions.push(eq(weeklyAvailability.staffMemberId, staffMemberId));
  } else {
    conditions.push(isNull(weeklyAvailability.staffMemberId));
  }
  
  const slots = await db.select()
    .from(weeklyAvailability)
    .where(and(...conditions));
  
  return slots.map(s => ({ startTime: s.startTime, endTime: s.endTime }));
}

async function getProviderBlocksForDate(
  providerType: string,
  providerId: string,
  date: Date,
  staffMemberId?: string
): Promise<{ startAt: Date; endAt: Date }[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const conditions = [
    eq(providerBlocks.providerType, providerType),
    eq(providerBlocks.providerId, providerId),
    lte(providerBlocks.startAt, endOfDay),
    gte(providerBlocks.endAt, startOfDay),
  ];
  
  if (staffMemberId) {
    conditions.push(eq(providerBlocks.staffMemberId, staffMemberId));
  }
  
  const blocks = await db.select()
    .from(providerBlocks)
    .where(and(...conditions));
  
  return blocks.map(b => ({ startAt: b.startAt, endAt: b.endAt }));
}

function isTimeBlockedByProviderBlock(
  date: Date,
  startTime: string,
  endTime: string,
  blocks: { startAt: Date; endAt: Date }[]
): boolean {
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  
  const slotStart = new Date(date);
  slotStart.setHours(startH, startM, 0, 0);
  
  const slotEnd = new Date(date);
  slotEnd.setHours(endH, endM, 0, 0);
  
  for (const block of blocks) {
    if (slotStart < block.endAt && slotEnd > block.startAt) {
      return true;
    }
  }
  
  return false;
}

export async function getStaffAvailabilitySlots(
  staffMemberId: string,
  startDate: string,
  endDate: string,
  serviceDurationMinutes?: number
): Promise<DayAvailability[]> {
  const [staff] = await db.select().from(staffMembers).where(eq(staffMembers.id, staffMemberId));
  if (!staff) {
    throw new Error("Staff member not found");
  }

  const [business] = await db.select().from(businesses).where(eq(businesses.id, staff.businessId));
  if (!business) {
    throw new Error("Business not found");
  }

  const availabilityRecords = await db.select().from(staffAvailability)
    .where(
      and(
        eq(staffAvailability.staffMemberId, staffMemberId),
        gte(staffAvailability.date, startDate),
        lte(staffAvailability.date, endDate)
      )
    );

  const activeStates = [BOOKING_STATES.DRAFT, BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.CONFIRMED];
  const existingBookings = await db.select().from(appointments)
    .where(
      and(
        eq(appointments.staffMemberId, staffMemberId),
        gte(appointments.appointmentDate, startDate),
        lte(appointments.appointmentDate, endDate),
        inArray(appointments.status, activeStates)
      )
    );

  const result: DayAvailability[] = [];
  const slotDuration = serviceDurationMinutes || SLOT_DURATION_MINUTES;
  const currentDate = new Date(startDate);
  const end = new Date(endDate);

  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dayOfWeek] as keyof typeof business.hoursOfOperation;

    const hours = business.hoursOfOperation?.[dayName] as { open: string; close: string; closed?: boolean } | undefined;
    if (!hours || hours.closed) {
      result.push({ date: dateStr, slots: [], totalAvailable: 0 });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const openHour = parseInt(hours.open.split(':')[0], 10);
    const closeHour = parseInt(hours.close.split(':')[0], 10);
    const possibleSlots = generateTimeSlots(openHour, closeHour, slotDuration);

    const dayAvailability = availabilityRecords.filter(r => r.date === dateStr);
    const dayBookings = existingBookings.filter(b => b.appointmentDate === dateStr);

    const slots: TimeSlot[] = possibleSlots.map(slot => {
      const blocked = dayAvailability.find(
        a => a.slotType === 'blocked' && doTimesOverlap(slot.start, slot.end, a.startTime, a.endTime)
      );
      if (blocked) {
        return { startTime: slot.start, endTime: slot.end, available: false, reason: 'blocked' as const };
      }

      const booking = dayBookings.find(b => {
        const bookingEnd = b.appointmentEndTime || 
          `${(parseInt(b.appointmentTime.split(':')[0]) + 1).toString().padStart(2, '0')}:${b.appointmentTime.split(':')[1]}`;
        return doTimesOverlap(slot.start, slot.end, b.appointmentTime, bookingEnd);
      });

      if (booking) {
        const reason = booking.status === BOOKING_STATES.DRAFT ? 'draft_locked' as const : 'booked' as const;
        return { startTime: slot.start, endTime: slot.end, available: false, reason };
      }

      return { startTime: slot.start, endTime: slot.end, available: true };
    });

    result.push({
      date: dateStr,
      slots,
      totalAvailable: slots.filter(s => s.available).length,
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}

export async function getPhotographerAvailabilitySlots(
  photographerId: string,
  startDate: string,
  endDate: string,
  serviceDurationHours?: number
): Promise<DayAvailability[]> {
  const [photographer] = await db.select().from(photographers).where(eq(photographers.id, photographerId));
  if (!photographer) {
    throw new Error("Photographer not found");
  }

  // Get travel buffer setting (default 30 mins)
  const travelBufferMinutes = photographer.travelBufferMinutes || 30;

  // Get blackout dates for this photographer
  const blackoutDates = await db.select().from(photographerBlackoutDates)
    .where(
      and(
        eq(photographerBlackoutDates.photographerId, photographerId),
        gte(photographerBlackoutDates.date, startDate),
        lte(photographerBlackoutDates.date, endDate)
      )
    );
  const blackoutDateSet = new Set(blackoutDates.map(d => d.date));

  const availabilityRecords = await db.select().from(photographerAvailability)
    .where(
      and(
        eq(photographerAvailability.photographerId, photographerId),
        gte(photographerAvailability.date, startDate),
        lte(photographerAvailability.date, endDate)
      )
    );

  const activeStates = [BOOKING_STATES.DRAFT, BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.CONFIRMED];
  const existingBookings = await db.select().from(shootBookings)
    .where(
      and(
        eq(shootBookings.photographerId, photographerId),
        gte(shootBookings.date, startDate),
        lte(shootBookings.date, endDate),
        inArray(shootBookings.status, activeStates)
      )
    );

  const result: DayAvailability[] = [];
  const slotDurationMinutes = (serviceDurationHours || 1) * 60;
  const currentDate = new Date(startDate);
  const end = new Date(endDate);

  while (currentDate <= end) {
    const dateStr = currentDate.toISOString().split('T')[0];

    // Check if this date is a blackout date
    if (blackoutDateSet.has(dateStr)) {
      result.push({ date: dateStr, slots: [], totalAvailable: 0 });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const dayOfWeek = currentDate.getDay();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[dayOfWeek] as keyof typeof photographer.hoursOfOperation;

    const hours = photographer.hoursOfOperation?.[dayName] as { open: string; close: string; closed?: boolean } | undefined;
    if (!hours || hours.closed) {
      result.push({ date: dateStr, slots: [], totalAvailable: 0 });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const openHour = parseInt(hours.open.split(':')[0], 10);
    const closeHour = parseInt(hours.close.split(':')[0], 10);
    const possibleSlots = generateTimeSlots(openHour, closeHour, 60);

    const dayAvailability = availabilityRecords.filter(r => r.date === dateStr);
    const dayBookings = existingBookings.filter(b => b.date === dateStr);

    const slots: TimeSlot[] = possibleSlots.map(slot => {
      const blocked = dayAvailability.find(
        a => a.slotType === 'blocked' && doTimesOverlap(slot.start, slot.end, a.startTime, a.endTime)
      );
      if (blocked) {
        return { startTime: slot.start, endTime: slot.end, available: false, reason: 'blocked' as const };
      }

      // Check if slot overlaps with any booking INCLUDING travel buffer
      const booking = dayBookings.find(b => {
        // Calculate buffered booking window
        const bookingStartMins = timeToMinutes(b.startTime);
        const bookingEndMins = timeToMinutes(b.endTime);
        const bufferedStart = Math.max(0, bookingStartMins - travelBufferMinutes);
        const bufferedEnd = Math.min(24 * 60, bookingEndMins + travelBufferMinutes);
        
        const slotStartMins = timeToMinutes(slot.start);
        const slotEndMins = timeToMinutes(slot.end);
        
        // Check overlap with buffered window
        return slotStartMins < bufferedEnd && slotEndMins > bufferedStart;
      });

      if (booking) {
        const reason = booking.status === BOOKING_STATES.DRAFT ? 'draft_locked' as const : 'booked' as const;
        return { startTime: slot.start, endTime: slot.end, available: false, reason };
      }

      return { startTime: slot.start, endTime: slot.end, available: true };
    });

    result.push({
      date: dateStr,
      slots,
      totalAvailable: slots.filter(s => s.available).length,
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}

export async function isSlotAvailable(
  type: 'staff' | 'photographer',
  providerId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<{ available: boolean; reason?: string }> {
  const activeStates = [BOOKING_STATES.DRAFT, BOOKING_STATES.PENDING_PAYMENT, BOOKING_STATES.PENDING_PROVIDER, BOOKING_STATES.CONFIRMED];
  const dateObj = new Date(date);

  if (type === 'staff') {
    // Check provider_blocks table first
    const [staff] = await db.select().from(staffMembers).where(eq(staffMembers.id, providerId));
    if (staff) {
      const blocks = await getProviderBlocksForDate('business', staff.businessId, dateObj, providerId);
      if (isTimeBlockedByProviderBlock(dateObj, startTime, endTime, blocks)) {
        return { available: false, reason: 'Staff has blocked this time' };
      }
    }

    const blockedSlot = await db.select().from(staffAvailability)
      .where(
        and(
          eq(staffAvailability.staffMemberId, providerId),
          eq(staffAvailability.date, date),
          eq(staffAvailability.slotType, 'blocked')
        )
      );

    for (const slot of blockedSlot) {
      if (doTimesOverlap(startTime, endTime, slot.startTime, slot.endTime)) {
        return { available: false, reason: 'Staff has blocked this time' };
      }
    }

    const existingBookings = await db.select().from(appointments)
      .where(
        and(
          eq(appointments.staffMemberId, providerId),
          eq(appointments.appointmentDate, date),
          inArray(appointments.status, activeStates)
        )
      );

    for (const booking of existingBookings) {
      const bookingEnd = booking.appointmentEndTime || 
        `${(parseInt(booking.appointmentTime.split(':')[0]) + 1).toString().padStart(2, '0')}:${booking.appointmentTime.split(':')[1]}`;
      
      if (doTimesOverlap(startTime, endTime, booking.appointmentTime, bookingEnd)) {
        if (booking.status === BOOKING_STATES.DRAFT) {
          return { available: false, reason: 'Slot is temporarily held by another customer' };
        }
        return { available: false, reason: 'Slot is already booked' };
      }
    }

    return { available: true };
  }

  if (type === 'photographer') {
    // Check provider_blocks table first
    const photographerBlocks = await getProviderBlocksForDate('photographer', providerId, dateObj);
    if (isTimeBlockedByProviderBlock(dateObj, startTime, endTime, photographerBlocks)) {
      return { available: false, reason: 'Photographer has blocked this time' };
    }

    const blockedSlot = await db.select().from(photographerAvailability)
      .where(
        and(
          eq(photographerAvailability.photographerId, providerId),
          eq(photographerAvailability.date, date),
          eq(photographerAvailability.slotType, 'blocked')
        )
      );

    for (const slot of blockedSlot) {
      if (doTimesOverlap(startTime, endTime, slot.startTime, slot.endTime)) {
        return { available: false, reason: 'Photographer has blocked this time' };
      }
    }

    const existingBookings = await db.select().from(shootBookings)
      .where(
        and(
          eq(shootBookings.photographerId, providerId),
          eq(shootBookings.date, date),
          inArray(shootBookings.status, activeStates)
        )
      );

    for (const booking of existingBookings) {
      if (doTimesOverlap(startTime, endTime, booking.startTime, booking.endTime)) {
        if (booking.status === BOOKING_STATES.DRAFT) {
          return { available: false, reason: 'Slot is temporarily held by another customer' };
        }
        return { available: false, reason: 'Slot is already booked' };
      }
    }

    return { available: true };
  }

  return { available: false, reason: 'Invalid provider type' };
}

export async function getBusinessAvailability(
  businessId: string,
  startDate: string,
  endDate: string,
  serviceId?: string
): Promise<StaffAvailabilityResult[]> {
  const staffList = await db.select().from(staffMembers)
    .where(
      and(
        eq(staffMembers.businessId, businessId),
        eq(staffMembers.status, 'active')
      )
    );

  let serviceDuration: number | undefined;
  if (serviceId) {
    const [service] = await db.select().from(vendorServices).where(eq(vendorServices.id, serviceId));
    serviceDuration = service?.durationMinutes || undefined;
  }

  const results: StaffAvailabilityResult[] = [];

  for (const staff of staffList) {
    const availability = await getStaffAvailabilitySlots(
      staff.id,
      startDate,
      endDate,
      serviceDuration
    );

    results.push({
      staffMemberId: staff.id,
      staffName: staff.displayName || 'Staff Member',
      businessId,
      availability,
    });
  }

  return results;
}
