// server/Photographers/photographers.service.ts
import { db } from "../db";
import { photographers } from "@shared/schema";
import { eq } from "drizzle-orm";

export class PhotographerService {
  // Create photographer profile
  static async create(data: {
    userId: string;
    displayName: string;
    bio?: string;
    city?: string;
    state?: string;
    portfolioUrl?: string;
    hourlyRate: number;
    stripeAccountId: string;
  }) {
    const result = await db
      .insert(photographers)
      .values({
        userId: data.userId,
        displayName: data.displayName,
        bio: data.bio ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        portfolioUrl: data.portfolioUrl ?? null,
        hourlyRate: data.hourlyRate,
        stripeAccountId: data.stripeAccountId,
      })
      .returning();

    return result[0];
  }

  // List all photographers (basic, can add filters later)
  static async list() {
    return db.select().from(photographers);
  }

  // Get one photographer by id
  static async get(id: string) {
    const result = await db
      .select()
      .from(photographers)
      .where(eq(photographers.id, id))
      .limit(1);

    return result[0] ?? null;
  }

  // Update photographer
  static async update(
    id: string,
    data: Partial<{
      displayName: string;
      bio: string;
      city: string;
      state: string;
      portfolioUrl: string;
      hourlyRate: number;
      stripeAccountId: string;
    }>
  ) {
    const result = await db
      .update(photographers)
      .set(data)
      .where(eq(photographers.id, id))
      .returning();

    return result[0] ?? null;
  }

  // Delete photographer
  static async remove(id: string) {
    const result = await db
      .delete(photographers)
      .where(eq(photographers.id, id))
      .returning();

    return result[0] ?? null;
  }
}
