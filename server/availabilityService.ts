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
  bookingHolds,
  BOOKING_STATES,
  type BookingHold
} from "@shared/schema";
import { eq, and, or, gte, lte, inArray, ne, sql, isNull, lt } from "drizzle-orm";

// ============================================
// ERROR CODES
// ============================================
export const AVAILABILITY_ERRORS = {
  TIME_NOT_COMPATIBLE: 'TIME_NOT_COMPATIBLE',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  HOLD_NOT_FOUND: 'HOLD_NOT_FOUND',
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  INVALID_DATE: 'INVALID_DATE',
  OUTSIDE_HOURS: 'OUTSIDE_HOURS',
} as const;

export class AvailabilityError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AvailabilityError';
  }
}

// Default hold duration in minutes
export const DEFAULT_HOLD_DURATION_MINUTES = 10;

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

// Map dayOfWeek (0=Sunday...6=Saturday) to hoursOfOperation keys
const DAY_OF_WEEK_TO_KEY: Record<number, string> = {
  0: 'sunday',
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
};

// Reverse mapping: hoursOfOperation keys to dayOfWeek integers
const KEY_TO_DAY_OF_WEEK: Record<string, number> = {
  'sunday': 0,
  'monday': 1,
  'tuesday': 2,
  'wednesday': 3,
  'thursday': 4,
  'friday': 5,
  'saturday': 6,
};

/**
 * Normalize hoursOfOperation entry to canonical format.
 * 
 * Frontend format: { open: true, start: "09:00", end: "17:00" } or { open: false }
 * Legacy format: { open: "09:00", close: "17:00", closed?: boolean }
 * 
 * Returns: { isOpen: boolean, startTime?: string, endTime?: string }
 */
function normalizeHoursEntry(dayHours: any): { isOpen: boolean; startTime?: string; endTime?: string } {
  if (!dayHours) {
    return { isOpen: false };
  }
  
  // Frontend format: { open: false } = closed day
  if (dayHours.open === false) {
    return { isOpen: false };
  }
  
  // Frontend format: { open: true, start: "09:00", end: "17:00" }
  if (dayHours.open === true && dayHours.start && dayHours.end) {
    return { isOpen: true, startTime: dayHours.start, endTime: dayHours.end };
  }
  
  // Legacy format: { open: "09:00", close: "17:00", closed?: boolean }
  if (typeof dayHours.open === 'string' && typeof dayHours.close === 'string') {
    if (dayHours.closed) {
      return { isOpen: false };
    }
    return { isOpen: true, startTime: dayHours.open, endTime: dayHours.close };
  }
  
  // Default to closed for invalid data
  return { isOpen: false };
}

/**
 * Sync hoursOfOperation JSON field to weeklyAvailability table.
 * This is a safety net for legacy or external writers that update hoursOfOperation directly.
 * The dashboard writes directly to weeklyAvailability, so this sync ensures consistency.
 * 
 * Supports both frontend format and legacy format.
 */
export async function syncHoursOfOperationToWeeklyAvailability(
  providerType: 'photographer' | 'business',
  providerId: string,
  hoursOfOperation: Record<string, any> | null
): Promise<void> {
  console.log("[AVAILABILITY_SYNC] Syncing hoursOfOperation to weeklyAvailability for", providerType, providerId);
  console.log("[AVAILABILITY_SYNC] Input:", JSON.stringify(hoursOfOperation));
  
  if (!hoursOfOperation) {
    console.log("[AVAILABILITY_SYNC] No hoursOfOperation to sync");
    return;
  }
  
  // Delete existing weeklyAvailability rows for this provider (without staffMemberId)
  await db.delete(weeklyAvailability)
    .where(and(
      eq(weeklyAvailability.providerType, providerType),
      eq(weeklyAvailability.providerId, providerId),
      isNull(weeklyAvailability.staffMemberId)
    ));
  
  // Insert new rows for each day with availability
  const rowsToInsert = [];
  for (const [dayKey, dayHours] of Object.entries(hoursOfOperation)) {
    const dayOfWeek = KEY_TO_DAY_OF_WEEK[dayKey];
    if (dayOfWeek === undefined) continue;
    
    const normalized = normalizeHoursEntry(dayHours);
    console.log("[AVAILABILITY_SYNC]", dayKey, "-> normalized:", JSON.stringify(normalized));
    
    // Skip closed days
    if (!normalized.isOpen || !normalized.startTime || !normalized.endTime) {
      continue;
    }
    
    rowsToInsert.push({
      providerType,
      providerId,
      dayOfWeek,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      isActive: true,
      staffMemberId: null,
    });
  }
  
  if (rowsToInsert.length > 0) {
    await db.insert(weeklyAvailability).values(rowsToInsert);
    console.log("[AVAILABILITY_SYNC] Inserted", rowsToInsert.length, "weeklyAvailability rows");
  } else {
    console.log("[AVAILABILITY_SYNC] No open days to insert");
  }
}

/**
 * Sync weeklyAvailability table to hoursOfOperation JSON field.
 * This ensures all legacy read paths (profile banner, booking calendar) can read availability.
 * 
 * Called AFTER saving to weeklyAvailability table.
 */
export async function syncWeeklyAvailabilityToHoursOfOperation(
  providerType: 'photographer' | 'business',
  providerId: string
): Promise<void> {
  console.log("[AVAILABILITY_SYNC] Syncing weeklyAvailability to hoursOfOperation for", providerType, providerId);
  
  // Get all weekly availability rows for this provider
  const slots = await db.select()
    .from(weeklyAvailability)
    .where(and(
      eq(weeklyAvailability.providerType, providerType),
      eq(weeklyAvailability.providerId, providerId),
      isNull(weeklyAvailability.staffMemberId)
    ));
  
  console.log("[AVAILABILITY_SYNC] Found", slots.length, "weeklyAvailability rows");
  
  // Build hoursOfOperation object in frontend format
  // { sunday: { open: true, start: "09:00", end: "17:00" }, monday: { open: false }, ... }
  const hoursOfOperation: Record<string, { open: boolean; start?: string; end?: string }> = {
    sunday: { open: false },
    monday: { open: false },
    tuesday: { open: false },
    wednesday: { open: false },
    thursday: { open: false },
    friday: { open: false },
    saturday: { open: false },
  };
  
  for (const slot of slots) {
    if (!slot.isActive) continue;
    
    const dayKey = DAY_OF_WEEK_TO_KEY[slot.dayOfWeek];
    if (!dayKey) continue;
    
    hoursOfOperation[dayKey] = {
      open: true,
      start: slot.startTime,
      end: slot.endTime,
    };
  }
  
  console.log("[AVAILABILITY_SYNC] Built hoursOfOperation:", JSON.stringify(hoursOfOperation));
  
  // Update the provider's hoursOfOperation field
  if (providerType === 'photographer') {
    await db.update(photographers)
      .set({ hoursOfOperation })
      .where(eq(photographers.id, providerId));
    console.log("[AVAILABILITY_SYNC] Updated photographer.hoursOfOperation for", providerId);
  } else if (providerType === 'business') {
    await db.update(businesses)
      .set({ hoursOfOperation })
      .where(eq(businesses.id, providerId));
    console.log("[AVAILABILITY_SYNC] Updated business.hoursOfOperation for", providerId);
  }
}

async function getWeeklyAvailabilityForDay(
  providerType: string,
  providerId: string,
  dayOfWeek: number,
  staffMemberId?: string
): Promise<{ startTime: string; endTime: string }[]> {
  // First, try to get from weeklyAvailability table
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
  
  console.log("[AVAILABILITY_DEBUG] getWeeklyAvailabilityForDay:");
  console.log("[AVAILABILITY_DEBUG]   providerType:", providerType, "providerId:", providerId, "dayOfWeek:", dayOfWeek);
  console.log("[AVAILABILITY_DEBUG]   weeklyAvailability table slots found:", slots.length);
  
  if (slots.length > 0) {
    return slots.map(s => ({ startTime: s.startTime, endTime: s.endTime }));
  }
  
  // FALLBACK: If no weeklyAvailability rows, check hoursOfOperation JSON field
  // This handles the case where dashboard saves to hoursOfOperation but calendar reads weeklyAvailability
  // Supports both frontend format { open: true, start, end } and legacy format { open, close, closed }
  if (!staffMemberId) {
    let hoursOfOperation: Record<string, any> | null = null;
    
    if (providerType === 'photographer') {
      const [photographer] = await db.select().from(photographers).where(eq(photographers.id, providerId));
      hoursOfOperation = photographer?.hoursOfOperation as typeof hoursOfOperation;
      console.log("[AVAILABILITY_DEBUG]   Fallback to photographer.hoursOfOperation:", JSON.stringify(hoursOfOperation));
    } else if (providerType === 'business') {
      const [business] = await db.select().from(businesses).where(eq(businesses.id, providerId));
      hoursOfOperation = business?.hoursOfOperation as typeof hoursOfOperation;
      console.log("[AVAILABILITY_DEBUG]   Fallback to business.hoursOfOperation:", JSON.stringify(hoursOfOperation));
    }
    
    if (hoursOfOperation) {
      const dayKey = DAY_OF_WEEK_TO_KEY[dayOfWeek];
      const dayHours = hoursOfOperation[dayKey];
      
      // Use normalizeHoursEntry to handle both frontend and legacy formats
      const normalized = normalizeHoursEntry(dayHours);
      
      if (normalized.isOpen && normalized.startTime && normalized.endTime) {
        console.log("[AVAILABILITY_DEBUG]   Found hours for", dayKey, ":", normalized.startTime, "-", normalized.endTime);
        return [{ startTime: normalized.startTime, endTime: normalized.endTime }];
      }
    }
  }
  
  console.log("[AVAILABILITY_DEBUG]   No availability found for day", dayOfWeek);
  return [];
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

    // Use normalizeHoursEntry to support both frontend and legacy formats
    const rawHours = business.hoursOfOperation?.[dayName];
    const normalized = normalizeHoursEntry(rawHours);
    if (!normalized.isOpen || !normalized.startTime || !normalized.endTime) {
      result.push({ date: dateStr, slots: [], totalAvailable: 0 });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const openHour = parseInt(normalized.startTime.split(':')[0], 10);
    const closeHour = parseInt(normalized.endTime.split(':')[0], 10);
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

    // Use normalizeHoursEntry to support both frontend and legacy formats
    const rawHours = photographer.hoursOfOperation?.[dayName];
    const normalized = normalizeHoursEntry(rawHours);
    if (!normalized.isOpen || !normalized.startTime || !normalized.endTime) {
      result.push({ date: dateStr, slots: [], totalAvailable: 0 });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const openHour = parseInt(normalized.startTime.split(':')[0], 10);
    const closeHour = parseInt(normalized.endTime.split(':')[0], 10);
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

// ============================================
// BOOKING HOLDS FUNCTIONS
// ============================================

/**
 * Get active booking holds for a provider on a specific date
 */
export async function getActiveHoldsForDate(
  providerType: 'business' | 'photographer',
  providerId: string,
  date: string,
  staffMemberId?: string
): Promise<BookingHold[]> {
  const now = new Date();
  
  const conditions = [
    eq(bookingHolds.providerType, providerType),
    eq(bookingHolds.providerId, providerId),
    eq(bookingHolds.holdDate, date),
    eq(bookingHolds.status, 'active'),
    gte(bookingHolds.expiresAt, now),
  ];
  
  if (staffMemberId) {
    conditions.push(eq(bookingHolds.staffMemberId, staffMemberId));
  }
  
  return db.select()
    .from(bookingHolds)
    .where(and(...conditions));
}

/**
 * Check if a time range is blocked by an active hold
 */
function isTimeBlockedByHold(
  startTime: string,
  endTime: string,
  holds: BookingHold[],
  excludeHoldId?: string
): { blocked: boolean; holdId?: string } {
  for (const hold of holds) {
    if (excludeHoldId && hold.id === excludeHoldId) continue;
    if (doTimesOverlap(startTime, endTime, hold.startTime, hold.endTime)) {
      return { blocked: true, holdId: hold.id };
    }
  }
  return { blocked: false };
}

/**
 * Calculate end time given start time and duration in minutes
 */
export function calculateEndTime(startTime: string, durationMinutes: number): string {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = startMinutes + durationMinutes;
  const endHours = Math.floor(endMinutes / 60);
  const endMins = endMinutes % 60;
  return `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}`;
}

/**
 * Parse date string to Date object at specific time
 */
function parseDateWithTime(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

// ============================================
// CALENDAR ENDPOINT - Available Days for Month
// ============================================

export interface CalendarDay {
  date: string;
  hasAvailability: boolean;
  totalSlots?: number;
}

export async function getAvailabilityCalendar(
  providerType: 'business' | 'photographer',
  providerId: string,
  year: number,
  month: number,
  staffMemberId?: string,
  serviceDurationMinutes?: number
): Promise<CalendarDay[]> {
  // Get first and last day of month
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);
  
  // Default to 60 minutes if not specified
  const slotDuration = serviceDurationMinutes || 60;
  
  const result: CalendarDay[] = [];
  const currentDate = new Date(startDate);
  
  // Get today for filtering past dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    
    // Skip past dates
    if (currentDate < today) {
      result.push({ date: dateStr, hasAvailability: false });
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    // Use the slot generation function which properly accounts for:
    // - Weekly windows
    // - Provider blocks
    // - Confirmed bookings
    // - Active holds
    const slots = await generateAvailabilitySlots(
      providerType,
      providerId,
      dateStr,
      slotDuration,
      staffMemberId
    );
    
    const availableCount = slots.filter(s => s.available).length;
    
    result.push({ 
      date: dateStr, 
      hasAvailability: availableCount > 0,
      totalSlots: availableCount
    });
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return result;
}

// ============================================
// SLOTS ENDPOINT - Dynamic Slot Generation
// ============================================

export interface GeneratedSlot {
  startTime: string;
  endTime: string;
  available: boolean;
  reason?: 'booked' | 'blocked' | 'held' | 'outside_hours';
}

export async function generateAvailabilitySlots(
  providerType: 'business' | 'photographer',
  providerId: string,
  date: string,
  serviceDurationMinutes: number,
  staffMemberId?: string,
  excludeHoldId?: string
): Promise<GeneratedSlot[]> {
  const dateObj = new Date(date + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();
  
  console.log("[SLOT_DEBUG] generateAvailabilitySlots:", { date, dayOfWeek, serviceDurationMinutes });
  
  // 1. Get weekly availability windows
  const windows = await getWeeklyAvailabilityForDay(
    providerType,
    providerId,
    dayOfWeek,
    staffMemberId
  );
  
  console.log("[SLOT_DEBUG] Windows found:", windows.length, windows);
  
  if (windows.length === 0) {
    console.log("[SLOT_DEBUG] No windows, returning empty");
    return [];
  }
  
  // 2. Get provider blocks for this date
  const blocks = await getProviderBlocksForDate(
    providerType,
    providerId,
    dateObj,
    staffMemberId
  );
  
  // 3. Get confirmed bookings for this date
  const bookings = await getConfirmedBookingsForDate(
    providerType,
    providerId,
    date,
    staffMemberId
  );
  
  // 4. Get active holds for this date
  const holds = await getActiveHoldsForDate(
    providerType,
    providerId,
    date,
    staffMemberId
  );
  
  // 5. Generate slots for each window
  const allSlots: GeneratedSlot[] = [];
  
  for (const window of windows) {
    const windowStart = timeToMinutes(window.startTime);
    const windowEnd = timeToMinutes(window.endTime);
    
    console.log("[SLOT_DEBUG] Processing window:", { 
      startTime: window.startTime, 
      endTime: window.endTime,
      windowStart, 
      windowEnd, 
      serviceDurationMinutes,
      willGenerateSlots: windowStart + serviceDurationMinutes <= windowEnd
    });
    
    let currentMinutes = windowStart;
    let slotCount = 0;
    
    while (currentMinutes + serviceDurationMinutes <= windowEnd) {
      slotCount++;
      const startHours = Math.floor(currentMinutes / 60);
      const startMins = currentMinutes % 60;
      const startTime = `${startHours.toString().padStart(2, '0')}:${startMins.toString().padStart(2, '0')}`;
      const endTime = calculateEndTime(startTime, serviceDurationMinutes);
      
      // Check if slot is blocked by provider block
      if (isTimeBlockedByProviderBlock(dateObj, startTime, endTime, blocks)) {
        allSlots.push({ startTime, endTime, available: false, reason: 'blocked' });
        currentMinutes += 15; // Advance by 15 minutes to find next slot
        continue;
      }
      
      // Check if slot overlaps with confirmed booking
      const bookingConflict = bookings.find(b => 
        doTimesOverlap(startTime, endTime, b.startTime, b.endTime)
      );
      if (bookingConflict) {
        allSlots.push({ startTime, endTime, available: false, reason: 'booked' });
        currentMinutes += 15;
        continue;
      }
      
      // Check if slot overlaps with active hold
      const holdCheck = isTimeBlockedByHold(startTime, endTime, holds, excludeHoldId);
      if (holdCheck.blocked) {
        allSlots.push({ startTime, endTime, available: false, reason: 'held' });
        currentMinutes += 15;
        continue;
      }
      
      // Slot is available
      allSlots.push({ startTime, endTime, available: true });
      currentMinutes += 15; // 15-minute increments for slot starts
    }
    
    console.log("[SLOT_DEBUG] Window complete: generated", slotCount, "slots");
  }
  
  const availableSlots = allSlots.filter(s => s.available).length;
  console.log("[SLOT_DEBUG] Total slots:", allSlots.length, "Available:", availableSlots);
  
  return allSlots;
}

/**
 * Get confirmed bookings for a date (both appointments and shoot_bookings)
 */
async function getConfirmedBookingsForDate(
  providerType: 'business' | 'photographer',
  providerId: string,
  date: string,
  staffMemberId?: string
): Promise<{ startTime: string; endTime: string; status: string }[]> {
  const activeStates = [
    BOOKING_STATES.DRAFT,
    BOOKING_STATES.PENDING_PAYMENT,
    BOOKING_STATES.PENDING_PROVIDER,
    BOOKING_STATES.CONFIRMED
  ];
  
  if (providerType === 'business') {
    const conditions = [
      eq(appointments.businessId, providerId),
      eq(appointments.appointmentDate, date),
      inArray(appointments.status, activeStates),
    ];
    
    if (staffMemberId) {
      conditions.push(eq(appointments.staffMemberId, staffMemberId));
    }
    
    const appts = await db.select()
      .from(appointments)
      .where(and(...conditions));
    
    return appts.map(a => ({
      startTime: a.appointmentTime,
      endTime: a.appointmentEndTime || calculateEndTime(a.appointmentTime, a.durationMinutes || 60),
      status: a.status,
    }));
  }
  
  if (providerType === 'photographer') {
    const shoots = await db.select()
      .from(shootBookings)
      .where(and(
        eq(shootBookings.photographerId, providerId),
        eq(shootBookings.date, date),
        inArray(shootBookings.status, activeStates)
      ));
    
    return shoots.map(s => ({
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
    }));
  }
  
  return [];
}

// ============================================
// VALIDATE ENDPOINT - Service + Time Compatibility
// ============================================

export interface ValidationResult {
  valid: boolean;
  errorCode?: string;
  errorMessage?: string;
  serviceDurationMinutes?: number;
  servicePriceCents?: number;
  serviceName?: string;
}

export async function validateBookingSlot(
  providerType: 'business' | 'photographer',
  providerId: string,
  serviceId: string,
  date: string,
  startTime: string,
  staffMemberId?: string,
  excludeHoldId?: string
): Promise<ValidationResult> {
  // 1. Fetch service details
  let serviceDurationMinutes: number;
  let servicePriceCents: number;
  let serviceName: string;
  
  if (providerType === 'business') {
    const [service] = await db.select()
      .from(vendorServices)
      .where(eq(vendorServices.id, serviceId));
    
    if (!service) {
      return {
        valid: false,
        errorCode: AVAILABILITY_ERRORS.SERVICE_NOT_FOUND,
        errorMessage: 'Service not found',
      };
    }
    
    serviceDurationMinutes = service.durationMinutes || 60;
    servicePriceCents = Math.round((service.price || 0) * 100); // Convert to cents
    serviceName = service.name;
  } else {
    const [service] = await db.select()
      .from(photographerServices)
      .where(eq(photographerServices.id, serviceId));
    
    if (!service) {
      return {
        valid: false,
        errorCode: AVAILABILITY_ERRORS.SERVICE_NOT_FOUND,
        errorMessage: 'Service not found',
      };
    }
    
    // Use packageHours for duration, or estimatedDurationMinutes, or default to 1 hour
    serviceDurationMinutes = service.estimatedDurationMinutes || (service.packageHours ? service.packageHours * 60 : 60);
    // Price is already in cents
    servicePriceCents = service.priceCents || service.hourlyRateCents || 0;
    serviceName = service.name;
  }
  
  const endTime = calculateEndTime(startTime, serviceDurationMinutes);
  const dateObj = new Date(date + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();
  
  // 2. Check if date is valid (not in past)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dateObj < today) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.INVALID_DATE,
      errorMessage: 'Cannot book dates in the past',
    };
  }
  
  // 3. Check weekly availability windows
  const windows = await getWeeklyAvailabilityForDay(
    providerType,
    providerId,
    dayOfWeek,
    staffMemberId
  );
  
  // Check if slot fits within any window
  const slotStartMins = timeToMinutes(startTime);
  const slotEndMins = timeToMinutes(endTime);
  
  // First check if start time is within any window
  const startsInWindow = windows.some(w => {
    const windowStart = timeToMinutes(w.startTime);
    const windowEnd = timeToMinutes(w.endTime);
    return slotStartMins >= windowStart && slotStartMins < windowEnd;
  });
  
  if (!startsInWindow) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.OUTSIDE_HOURS,
      errorMessage: 'Selected start time is outside available hours',
    };
  }
  
  // Check if the full duration fits within a window
  const fitsInWindow = windows.some(w => {
    const windowStart = timeToMinutes(w.startTime);
    const windowEnd = timeToMinutes(w.endTime);
    return slotStartMins >= windowStart && slotEndMins <= windowEnd;
  });
  
  if (!fitsInWindow) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.TIME_NOT_COMPATIBLE,
      errorMessage: `Service duration (${serviceDurationMinutes} min) does not fit within available hours`,
    };
  }
  
  // 4. Check provider blocks
  const blocks = await getProviderBlocksForDate(
    providerType,
    providerId,
    dateObj,
    staffMemberId
  );
  
  if (isTimeBlockedByProviderBlock(dateObj, startTime, endTime, blocks)) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
      errorMessage: 'Provider has blocked this time',
    };
  }
  
  // 5. Check existing bookings
  const bookings = await getConfirmedBookingsForDate(
    providerType,
    providerId,
    date,
    staffMemberId
  );
  
  const bookingConflict = bookings.find(b => 
    doTimesOverlap(startTime, endTime, b.startTime, b.endTime)
  );
  
  if (bookingConflict) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
      errorMessage: 'Slot is already booked',
    };
  }
  
  // 6. Check active holds
  const holds = await getActiveHoldsForDate(
    providerType,
    providerId,
    date,
    staffMemberId
  );
  
  const holdCheck = isTimeBlockedByHold(startTime, endTime, holds, excludeHoldId);
  if (holdCheck.blocked) {
    return {
      valid: false,
      errorCode: AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
      errorMessage: 'Slot is temporarily held by another customer',
    };
  }
  
  // Valid!
  return {
    valid: true,
    serviceDurationMinutes,
    servicePriceCents,
    serviceName,
  };
}

// ============================================
// HOLD ENDPOINT - Create Temporary Hold
// ============================================

export interface CreateHoldParams {
  providerType: 'business' | 'photographer';
  providerId: string;
  staffMemberId?: string;
  userId: string;
  serviceId: string;
  date: string;
  startTime: string;
  holdDurationMinutes?: number;
}

export interface HoldResult {
  holdId: string;
  expiresAt: Date;
  serviceName: string;
  servicePriceCents: number;
  durationMinutes: number;
  startTime: string;
  endTime: string;
}

export async function createBookingHold(params: CreateHoldParams): Promise<HoldResult> {
  const holdDuration = params.holdDurationMinutes || DEFAULT_HOLD_DURATION_MINUTES;

  // Validate slot first (lightweight check before locking)
  const validation = await validateBookingSlot(
    params.providerType,
    params.providerId,
    params.serviceId,
    params.date,
    params.startTime,
    params.staffMemberId
  );

  if (!validation.valid) {
    throw new AvailabilityError(
      validation.errorCode || AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
      validation.errorMessage || 'Slot not available'
    );
  }

  const endTime = calculateEndTime(params.startTime, validation.serviceDurationMinutes!);
  const expiresAt = new Date(Date.now() + holdDuration * 60 * 1000);
  const startAt = parseDateWithTime(params.date, params.startTime);
  const endAt = parseDateWithTime(params.date, endTime);

  // Use a serializable transaction with SELECT FOR UPDATE to prevent race conditions.
  // Two concurrent requests for the same slot: the second will block on the row lock
  // until the first commits, then see the hold and fail gracefully.
  try {
    const result = await db.transaction(async (tx) => {
      // Lock any existing active holds for this provider+date range to prevent races
      const conflictingHolds = await tx.select()
        .from(bookingHolds)
        .where(and(
          eq(bookingHolds.providerType, params.providerType),
          eq(bookingHolds.providerId, params.providerId),
          eq(bookingHolds.holdDate, params.date),
          eq(bookingHolds.status, 'active'),
          gte(bookingHolds.expiresAt, new Date()),
          params.staffMemberId ? eq(bookingHolds.staffMemberId, params.staffMemberId) : sql`1=1`
        ))
        .for('update');

      // Re-check for overlap within the locked set
      const hasConflict = conflictingHolds.some(h =>
        doTimesOverlap(params.startTime, endTime, h.startTime, h.endTime)
      );

      if (hasConflict) {
        throw new AvailabilityError(
          AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
          'This slot was just booked. Please choose another time.'
        );
      }

      // Also re-check confirmed bookings within the transaction
      const bookings = await getConfirmedBookingsForDate(
        params.providerType, params.providerId, params.date, params.staffMemberId
      );
      const bookingConflict = bookings.find(b =>
        doTimesOverlap(params.startTime, endTime, b.startTime, b.endTime)
      );
      if (bookingConflict) {
        throw new AvailabilityError(
          AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
          'Slot is already booked'
        );
      }

      // Insert hold within the transaction
      const [hold] = await tx.insert(bookingHolds).values({
        providerType: params.providerType,
        providerId: params.providerId,
        staffMemberId: params.staffMemberId,
        userId: params.userId,
        serviceId: params.serviceId,
        serviceName: validation.serviceName!,
        servicePriceCents: validation.servicePriceCents!,
        durationMinutes: validation.serviceDurationMinutes!,
        holdDate: params.date,
        startTime: params.startTime,
        endTime,
        startAt,
        endAt,
        expiresAt,
      }).returning();

      return hold;
    });

    console.log(`[BookingHold] Created hold ${result.id} for user ${params.userId}, expires at ${expiresAt.toISOString()}`);

    return {
      holdId: result.id,
      expiresAt,
      serviceName: validation.serviceName!,
      servicePriceCents: validation.servicePriceCents!,
      durationMinutes: validation.serviceDurationMinutes!,
      startTime: params.startTime,
      endTime,
    };
  } catch (err) {
    if (err instanceof AvailabilityError) throw err;
    // PostgreSQL unique violation (duplicate slot) is a second layer of protection
    if ((err as any)?.code === '23505') {
      throw new AvailabilityError(
        AVAILABILITY_ERRORS.SLOT_UNAVAILABLE,
        'This slot was just booked. Please choose another time.'
      );
    }
    throw err;
  }
}

// ============================================
// CONFIRM ENDPOINT - Convert Hold to Booking
// ============================================

export interface ConfirmHoldResult {
  bookingId: string;
  bookingType: 'appointment' | 'shoot_booking';
  status: string;
}

export async function confirmBookingHold(
  holdId: string,
  userId: string
): Promise<{ hold: BookingHold }> {
  // 1. Find and validate hold
  const [hold] = await db.select()
    .from(bookingHolds)
    .where(and(
      eq(bookingHolds.id, holdId),
      eq(bookingHolds.userId, userId)
    ));
  
  if (!hold) {
    throw new AvailabilityError(
      AVAILABILITY_ERRORS.HOLD_NOT_FOUND,
      'Booking hold not found'
    );
  }
  
  if (hold.status !== 'active') {
    throw new AvailabilityError(
      AVAILABILITY_ERRORS.HOLD_EXPIRED,
      `Booking hold is ${hold.status}`
    );
  }
  
  if (new Date() > hold.expiresAt) {
    // Mark as expired
    await db.update(bookingHolds)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(bookingHolds.id, holdId));
    
    throw new AvailabilityError(
      AVAILABILITY_ERRORS.HOLD_EXPIRED,
      'Booking hold has expired'
    );
  }
  
  // Return the hold - actual booking creation happens via existing routes
  return { hold };
}

/**
 * Mark a hold as converted when booking is created
 */
export async function markHoldAsConverted(
  holdId: string,
  bookingId: string,
  bookingType: 'appointment' | 'shoot_booking'
): Promise<void> {
  await db.update(bookingHolds)
    .set({
      status: 'converted',
      convertedToBookingId: bookingId,
      convertedToBookingType: bookingType,
      updatedAt: new Date(),
    })
    .where(eq(bookingHolds.id, holdId));
  
  console.log(`[BookingHold] Hold ${holdId} converted to ${bookingType} ${bookingId}`);
}

/**
 * Release a hold (on payment failure or user cancellation)
 */
export async function releaseBookingHold(holdId: string): Promise<void> {
  await db.update(bookingHolds)
    .set({ status: 'released', updatedAt: new Date() })
    .where(eq(bookingHolds.id, holdId));
  
  console.log(`[BookingHold] Hold ${holdId} released`);
}

// ============================================
// HOLD EXPIRY CLEANUP JOB
// ============================================

export async function expireOldHolds(): Promise<number> {
  const now = new Date();
  
  // Get active holds that have expired
  const expiredHolds = await db.select({ id: bookingHolds.id })
    .from(bookingHolds)
    .where(and(
      eq(bookingHolds.status, 'active'),
      lt(bookingHolds.expiresAt, now)
    ));
  
  if (expiredHolds.length === 0) {
    return 0;
  }
  
  // Update them to expired
  await db.update(bookingHolds)
    .set({ status: 'expired', updatedAt: now })
    .where(inArray(bookingHolds.id, expiredHolds.map(h => h.id)));
  
  console.log(`[BookingHold] Expired ${expiredHolds.length} holds`);
  
  return expiredHolds.length;
}

/**
 * Get hold by ID
 */
export async function getBookingHold(holdId: string): Promise<BookingHold | null> {
  const [hold] = await db.select()
    .from(bookingHolds)
    .where(eq(bookingHolds.id, holdId));
  
  return hold || null;
}

/**
 * Get user's active holds
 */
export async function getUserActiveHolds(userId: string): Promise<BookingHold[]> {
  const now = new Date();

  return db.select()
    .from(bookingHolds)
    .where(and(
      eq(bookingHolds.userId, userId),
      eq(bookingHolds.status, 'active'),
      gte(bookingHolds.expiresAt, now)
    ));
}

// ============================================
// UNIFIED AVAILABILITY ENGINE (NEW TABLES ONLY) -- NOT WIRED TO ANY ROUTE YET
// ============================================
// Standalone check against weeklyAvailability / providerBlocks / bookingHolds
// exclusively. Does NOT call isSlotAvailable, checkStaffSlotAvailable,
// checkPhotographerSlotAvailable, checkBusinessSlotAvailable, their reserve*
// counterparts, or any legacy *Availability table. Fully independent for now.

/**
 * Check a single provider/staff/photographer slot against the new
 * weekly-availability / provider-block / booking-hold tables only.
 *
 * `providerType === 'staff'`: weeklyAvailability, providerBlocks and
 * bookingHolds only ever store provider_type = 'business' | 'photographer'
 * (there is no 'staff' value in these tables' provider_type column -- see
 * shared/schema.ts). Staff are a business-scoped sub-resource: `providerId`
 * must be the staff member's businessId, and `staffMemberId` narrows the
 * business-scoped rows down to that staff member. This mirrors how
 * getWeeklyAvailabilityForDay / getProviderBlocksForDate / the exclusion
 * constraint in migrations/011_booking_holds_exclusion_constraint.sql already
 * treat staff.
 */
export async function checkProviderAvailability(
  providerType: 'business' | 'staff' | 'photographer',
  providerId: string,
  staffMemberId: string | null,
  date: string,
  startTime: string,
  endTime: string,
  serviceId?: string
): Promise<{ available: boolean; reason?: string }> {
  if (providerType === 'staff' && !staffMemberId) {
    return { available: false, reason: 'staffMemberId is required when providerType is "staff"' };
  }

  const dbProviderType: 'business' | 'photographer' = providerType === 'photographer' ? 'photographer' : 'business';
  const scopedStaffMemberId = providerType === 'staff' ? staffMemberId : null;

  const dateObj = parseDateWithTime(date, '00:00');
  const dayOfWeek = dateObj.getDay();

  // ---- 1. Weekly open-hours check, weeklyAvailability table only. ----
  // No fallback to the legacy hoursOfOperation JSON field here (unlike
  // getWeeklyAvailabilityForDay) -- if no row exists for this exact
  // provider/staff/day, we fail closed rather than assuming "open".
  const weeklyConditions = [
    eq(weeklyAvailability.providerType, dbProviderType),
    eq(weeklyAvailability.providerId, providerId),
    eq(weeklyAvailability.dayOfWeek, dayOfWeek),
    eq(weeklyAvailability.isActive, true),
  ];
  if (scopedStaffMemberId) {
    weeklyConditions.push(eq(weeklyAvailability.staffMemberId, scopedStaffMemberId));
  } else {
    weeklyConditions.push(isNull(weeklyAvailability.staffMemberId));
  }

  const windows = await db.select()
    .from(weeklyAvailability)
    .where(and(...weeklyConditions));

  if (windows.length === 0) {
    return {
      available: false,
      reason: `No weekly availability configured for this ${providerType === 'staff' ? 'staff member' : providerType} on this day`,
    };
  }

  const slotStartMins = timeToMinutes(startTime);
  const slotEndMins = timeToMinutes(endTime);

  const fitsInWindow = windows.some(w => {
    const windowStart = timeToMinutes(w.startTime);
    const windowEnd = timeToMinutes(w.endTime);
    return slotStartMins >= windowStart && slotEndMins <= windowEnd;
  });

  if (!fitsInWindow) {
    return { available: false, reason: 'Requested time is outside of open hours' };
  }

  // ---- 2. Buffer resolution. ----
  // Photographers have a real column (photographers.travelBufferMinutes,
  // confirmed present, default 30) applied symmetrically before/after the
  // slot. Business and staff have NO buffer column anywhere in the schema
  // today -- this 0 is deliberate, not an oversight, until a future
  // migration adds real per-business/per-staff buffer columns.
  let bufferMinutes = 0;
  if (providerType === 'photographer') {
    const [photographer] = await db.select({ travelBufferMinutes: photographers.travelBufferMinutes })
      .from(photographers)
      .where(eq(photographers.id, providerId));
    bufferMinutes = photographer?.travelBufferMinutes ?? 30;
  }

  const slotStart = parseDateWithTime(date, startTime);
  const slotEnd = parseDateWithTime(date, endTime);
  const bufferedStart = new Date(slotStart.getTime() - bufferMinutes * 60_000);
  const bufferedEnd = new Date(slotEnd.getTime() + bufferMinutes * 60_000);

  // ---- 3. providerBlocks check (buffer-expanded window). ----
  const blocks = await getProviderBlocksForDate(
    dbProviderType,
    providerId,
    dateObj,
    scopedStaffMemberId || undefined
  );
  const blockConflict = blocks.some(b => bufferedStart < b.endAt && bufferedEnd > b.startAt);
  if (blockConflict) {
    return { available: false, reason: 'Provider has blocked this time' };
  }

  // ---- 4. bookingHolds check, mirroring the DB exclusion constraint. ----
  // migrations/011_booking_holds_exclusion_constraint.sql defines
  // no_overlapping_active_holds as: EXCLUDE USING gist (provider_type WITH =,
  // provider_id WITH =, COALESCE(staff_member_id, '') WITH =,
  // tsrange(start_at, end_at) WITH &&) WHERE (status = 'active'). We mirror
  // each piece:
  //   - provider_type / provider_id: plain equality, same as the constraint.
  //   - COALESCE(staff_member_id, '') equality: reproduced below as
  //     "eq(staffMemberId, X)" when a staff id is given, or "isNull(...)"
  //     when it's not -- this has the same match semantics as the COALESCE
  //     (two NULLs collapse to '' = '' and match; a NULL and a real id never
  //     match, since '' never equals a real id).
  //   - tsrange(start_at, end_at) WITH &&: tsrange's default bounds are
  //     '[)' (inclusive start, exclusive end), so two ranges overlap iff
  //     start1 < end2 && end1 > start2 -- reproduced below as a plain Date
  //     comparison on the buffer-expanded window.
  //   - WHERE (status = 'active'): reproduced as eq(status, 'active'). We
  //     additionally require expiresAt >= now (matching this file's existing
  //     getActiveHoldsForDate convention) since the DB constraint itself has
  //     no expiry awareness -- an expired-but-not-yet-swept row still counts
  //     as a real DB-level conflict, but we don't want it blocking a fresh
  //     request here.
  const now = new Date();
  const holdConditions = [
    eq(bookingHolds.providerType, dbProviderType),
    eq(bookingHolds.providerId, providerId),
    eq(bookingHolds.status, 'active'),
    gte(bookingHolds.expiresAt, now),
  ];
  if (scopedStaffMemberId) {
    holdConditions.push(eq(bookingHolds.staffMemberId, scopedStaffMemberId));
  } else {
    holdConditions.push(isNull(bookingHolds.staffMemberId));
  }

  const holds = await db.select()
    .from(bookingHolds)
    .where(and(...holdConditions));

  const holdConflict = holds.some(h => bufferedStart < h.endAt && bufferedEnd > h.startAt);
  if (holdConflict) {
    return { available: false, reason: 'Slot is temporarily held by another customer' };
  }

  return { available: true };
}
