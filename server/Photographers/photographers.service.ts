// server/Photographers/photographers.service.ts
import { db } from "../db";
import { photographers } from "@shared/schema";
import { and, eq } from "drizzle-orm";

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

  // List all photographers visible to the public (basic, can add filters later)
  // Matches the visibility filtering already applied by storage.listPhotographers()
  static async list() {
    return db
      .select()
      .from(photographers)
      .where(eq(photographers.visibilityStatus, "public"));
  }

  // Get one photographer by id, restricted to public visibility.
  // Hidden/flagged photographers 404 here, same as isBusinessVisibleToPublic
  // does for businesses. Owner self-lookups (resolvePhotographerForUser) fall
  // back to getByUserId, which is intentionally left unfiltered.
  static async get(id: string) {
    const result = await db
      .select()
      .from(photographers)
      .where(and(eq(photographers.id, id), eq(photographers.visibilityStatus, "public")))
      .limit(1);

    return result[0] ?? null;
  }

  // Get photographer by userId
  static async getByUserId(userId: string) {
    const result = await db
      .select()
      .from(photographers)
      .where(eq(photographers.userId, userId))
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
