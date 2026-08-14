import { db } from "./db";
import { appointments } from "../shared/schema";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { storage } from "./storage";
import { sendAppointmentReminderEmail } from "./emailService";

async function sendDueReminders(windowMinutes: number, field: '24h' | '2h'): Promise<void> {
  const sentColumn = field === '24h' ? 'reminder_24h_sent' : 'reminder_2h_sent';

  const now = new Date();
  const windowStart = new Date(now.getTime() + (windowMinutes - 15) * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + (windowMinutes + 15) * 60 * 1000);

  // Build ISO date/time strings for the appointment window
  const startIso = windowStart.toISOString();
  const endIso   = windowEnd.toISOString();

  // Fetch confirmed appointments whose datetime falls inside the window and haven't been reminded yet
  const rows = await db.execute<{
    id: string;
    client_id: string;
    business_id: string;
    service_name: string | null;
    appointment_date: string;
    appointment_time: string;
  }>(sql`
    SELECT id, client_id, business_id, service_name, appointment_date, appointment_time
    FROM appointments
    WHERE status = 'confirmed'
      AND ${sql.raw(sentColumn)} = false
      AND (appointment_date || 'T' || appointment_time)::timestamptz
           BETWEEN ${startIso}::timestamptz AND ${endIso}::timestamptz
  `);

  for (const row of rows.rows) {
    try {
      const [client, business] = await Promise.all([
        storage.getUser(row.client_id),
        storage.getBusiness(row.business_id),
      ]);

      if (!client?.email) continue;

      await sendAppointmentReminderEmail({
        toEmail: client.email,
        customerName: client.name ?? client.email,
        serviceName: row.service_name ?? 'your service',
        businessName: business?.name ?? 'your provider',
        appointmentDate: row.appointment_date,
        appointmentTime: row.appointment_time,
        windowLabel: field,
      });

      // Mark reminder sent
      await db.execute(sql`
        UPDATE appointments
        SET ${sql.raw(sentColumn)} = true
        WHERE id = ${row.id}
      `);

      console.log(`[Reminder] Sent ${field} reminder for appointment ${row.id}`);
    } catch (err) {
      console.error(`[Reminder] Failed to send ${field} reminder for appointment ${row.id}:`, err);
    }
  }
}

export function startReminderJob(intervalMs = 15 * 60 * 1000): void {
  const run = async () => {
    try {
      await Promise.all([
        sendDueReminders(24 * 60, '24h'),
        sendDueReminders(2 * 60, '2h'),
      ]);
    } catch (err) {
      console.error('[Reminder] Job failed:', err);
    }
  };

  run(); // Run immediately on startup
  setInterval(run, intervalMs);
  console.log(`[Reminder] Job started — interval ${intervalMs / 60000} min`);
}
