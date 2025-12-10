import { 
  type User, 
  type InsertUser, 
  type UpsertUser,
  type Business, 
  type InsertBusiness,
  type City,
  type InsertCity,
  type RefreshToken,
  type Photographer,
  type Review,
  type InsertReview,
  type ShootBooking,
  type Appointment,
  type Order,
  type Conversation,
  type InsertConversation,
  type Message,
  type InsertMessage,
  type PointTransaction,
  users,
  businesses,
  cities,
  refreshTokens,
  photographers,
  reviews,
  shootBookings,
  appointments,
  orders,
  conversations,
  messages,
  pointTransactions
} from "@shared/schema";
import { db } from "./db";
import { eq, ilike, or, and, sql, isNull } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";

// Input type for creating a photographer (no need for InsertPhotographer in schema)
export type NewPhotographerInput = {
  userId: string;
  displayName: string;
  bio?: string | null;
  city?: string | null;
  state?: string | null;
  portfolioUrl?: string | null;
  hourlyRate: number;
  stripeAccountId: string;
};

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  getBusiness(id: string): Promise<Business | undefined>;
  getBusinessByOwnerId(ownerId: string): Promise<Business | undefined>;
  getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]>;
  createBusiness(business: InsertBusiness): Promise<Business>;
  updateBusiness(id: string, updates: Partial<Business>): Promise<Business | undefined>;

  getCities(): Promise<City[]>;
  getCity(id: string): Promise<City | undefined>;
  createCity(city: InsertCity): Promise<City>;
  updateCityBusinessCount(cityId: string, count: number): Promise<void>;

  storeRefreshToken(userId: string, token: string, expiresAt: Date): Promise<string>;
  validateRefreshToken(token: string): Promise<{ userId: string; tokenId: string } | null>;
  revokeRefreshToken(tokenId: string): Promise<void>;
  revokeAllUserRefreshTokens(userId: string): Promise<void>;
  cleanupExpiredTokens(): Promise<void>;

  // Photographer CRUD
  createPhotographer(data: NewPhotographerInput): Promise<Photographer>;
  getPhotographer(id: string): Promise<Photographer | undefined>;
  listPhotographers(): Promise<Photographer[]>;
  updatePhotographer(id: string, updates: Partial<Photographer>): Promise<Photographer | undefined>;
  deletePhotographer(id: string): Promise<void>;

  // Reviews (verified purchases only)
  createReview(data: InsertReview): Promise<Review>;
  getReviewsByTarget(targetType: string, targetId: string): Promise<Review[]>;
  getReviewByBooking(bookingType: string, bookingId: string): Promise<Review | undefined>;
  hasReviewedBooking(bookingType: string, bookingId: string): Promise<boolean>;
  verifyCustomerCanReview(customerId: string, targetType: string, targetId: string, bookingType: string, bookingId: string): Promise<{ canReview: boolean; reason?: string }>;
  getReviewableBookings(customerId: string): Promise<{ shootBookings: ShootBooking[]; appointments: Appointment[]; orders: Order[] }>;
  updateTargetRating(targetType: string, targetId: string): Promise<void>;

  // Chat (Real-time messaging)
  getOrCreateConversation(participant1Id: string, participant2Id: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  getUserConversations(userId: string): Promise<(Conversation & { otherParticipant: User })[]>;
  createMessage(data: { conversationId: string; senderId: string; content: string }): Promise<Message>;
  getConversationMessages(conversationId: string, limit?: number, before?: string): Promise<Message[]>;
  markMessagesAsRead(conversationId: string, userId: string): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;

  // Outsyde Points (Loyalty System)
  // $1 = 100 points
  getUserPointsBalance(userId: string): Promise<number>;
  earnPoints(data: {
    userId: string;
    dollarAmountCents: number;
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<PointTransaction>;
  redeemPoints(data: {
    userId: string;
    points: number;
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<{ transaction: PointTransaction; discountCents: number } | { error: string }>;
  getPointTransactions(userId: string, limit?: number): Promise<PointTransaction[]>;
  calculatePointsValue(points: number): number; // Returns discount in cents

  // Referral system
  generateReferralCode(userId: string): Promise<string>;
  getUserReferralCode(userId: string): Promise<string | null>;
  getUserByReferralCode(code: string): Promise<User | undefined>;
  processReferral(newUserId: string, referralCode: string): Promise<{ success: boolean; referrerId?: string; error?: string }>;

  seedInitialData(): Promise<void>;
}

export class DatabaseStorage implements IStorage {

  // =========================
  // USERS
  // =========================

  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      sql`LOWER(${users.email}) = LOWER(${email})`
    );
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const result = await db.insert(users).values({
      id,
      email: insertUser.email,
      password: insertUser.password,
      name: insertUser.name,
      phone: insertUser.phone || null,
      isVendor: insertUser.isVendor ?? false,

      address: insertUser.address || null,
      city: insertUser.city || null,
      state: insertUser.state || null,
      zipCode: insertUser.zipCode || null,

      ageRange: insertUser.ageRange || null,
      gender: insertUser.gender || null,
      ethnicity: insertUser.ethnicity || null,
      nationality: insertUser.nationality || null,
      householdSize: insertUser.householdSize || null,
      incomeRange: insertUser.incomeRange || null,
      education: insertUser.education || null,
      occupation: insertUser.occupation || null,
      shoppingFrequency: insertUser.shoppingFrequency || null,

      selectedIndustries: (insertUser.selectedIndustries as string[]) || [],
      industryNiches: (insertUser.industryNiches as Record<string, string[]>) || {},
      industryValues: (insertUser.industryValues as Record<string, string[]>) || {},
    }).returning();
    return result[0];
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const result = await db.update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return result[0];
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({
        id: userData.id,
        email: userData.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        profileImageUrl: userData.profileImageUrl,
        name: userData.firstName && userData.lastName 
          ? `${userData.firstName} ${userData.lastName}` 
          : userData.firstName || userData.email?.split('@')[0] || 'User',
        isOAuthUser: true,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: userData.email,
          firstName: userData.firstName,
          lastName: userData.lastName,
          profileImageUrl: userData.profileImageUrl,
        },
      })
      .returning();
    return user;
  }

  // =========================
  // BUSINESSES
  // =========================

  async getBusiness(id: string): Promise<Business | undefined> {
    const result = await db.select().from(businesses).where(eq(businesses.id, id));
    return result[0];
  }

  async getBusinessByOwnerId(ownerId: string): Promise<Business | undefined> {
    const result = await db.select().from(businesses).where(eq(businesses.ownerId, ownerId));
    return result[0];
  }

  async getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]> {
    const conditions: any[] = [];

    if (filters?.city) {
      conditions.push(sql`LOWER(${businesses.city}) = LOWER(${filters.city})`);
    }

    if (filters?.category && filters.category !== "All") {
      conditions.push(eq(businesses.category, filters.category));
    }

    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      conditions.push(
        or(
          ilike(businesses.name, searchTerm),
          ilike(businesses.description, searchTerm)
        )
      );
    }

    if (conditions.length > 0) {
      return db.select().from(businesses).where(and(...conditions));
    }

    return db.select().from(businesses);
  }

  async createBusiness(insertBusiness: InsertBusiness): Promise<Business> {
    const id = randomUUID();
    const result = await db.insert(businesses).values({
      id,
      ownerId: insertBusiness.ownerId,
      name: insertBusiness.name,
      category: insertBusiness.category,
      description: insertBusiness.description || null,
      isStartup: insertBusiness.isStartup ?? false,
      yearsInBusiness: insertBusiness.yearsInBusiness || null,
      employeeCount: insertBusiness.employeeCount || null,
      businessType: insertBusiness.businessType || null,
      hasPhysicalLocation: insertBusiness.hasPhysicalLocation ?? true,
      address: insertBusiness.address || null,
      city: insertBusiness.city || null,
      state: insertBusiness.state || null,
      zipCode: insertBusiness.zipCode || null,
      websiteUrl: insertBusiness.websiteUrl || null,
      socialMedia: insertBusiness.socialMedia || null,
      coverImage: insertBusiness.coverImage || null,
      logoImage: insertBusiness.logoImage || null,
      rating: 0,
      reviewCount: 0,
      subscriptionActive: insertBusiness.subscriptionActive ?? false,
    }).returning();

    return result[0];
  }

  async updateBusiness(id: string, updates: Partial<Business>): Promise<Business | undefined> {
    const result = await db.update(businesses)
      .set(updates)
      .where(eq(businesses.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // CITIES
  // =========================

  async getCities(): Promise<City[]> {
    return db.select().from(cities);
  }

  async getCity(id: string): Promise<City | undefined> {
    const result = await db.select().from(cities).where(eq(cities.id, id));
    return result[0];
  }

  async createCity(city: InsertCity): Promise<City> {
    const result = await db.insert(cities).values({
      id: city.id,
      name: city.name,
      state: city.state,
      businessCount: city.businessCount ?? 0,
      imageUrl: city.imageUrl || null,
      trending: city.trending ?? false,
    }).returning();
    return result[0];
  }

  async updateCityBusinessCount(cityId: string, count: number): Promise<void> {
    await db.update(cities)
      .set({ businessCount: count })
      .where(eq(cities.id, cityId));
  }

  // =========================
  // REFRESH TOKENS
  // =========================

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async storeRefreshToken(userId: string, token: string, expiresAt: Date): Promise<string> {
    const tokenHash = this.hashToken(token);
    const result = await db.insert(refreshTokens).values({
      userId,
      tokenHash,
      expiresAt,
    }).returning();
    return result[0].id;
  }

  async validateRefreshToken(token: string): Promise<{ userId: string; tokenId: string } | null> {
    const tokenHash = this.hashToken(token);
    const result = await db.select().from(refreshTokens).where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.expiresAt} > NOW()`
      )
    );

    if (result.length === 0) {
      return null;
    }

    return {
      userId: result[0].userId,
      tokenId: result[0].id,
    };
  }

  async revokeRefreshToken(tokenId: string): Promise<void> {
    await db.update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, tokenId));
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await db.update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt)
        )
      );
  }

  async cleanupExpiredTokens(): Promise<void> {
    await db.delete(refreshTokens).where(
      sql`${refreshTokens.expiresAt} < NOW()`
    );
  }

  // =========================
  // PHOTOGRAPHERS
  // =========================

  async createPhotographer(data: NewPhotographerInput): Promise<Photographer> {
    const id = randomUUID();
    const result = await db.insert(photographers).values({
      id,
      userId: data.userId,
      displayName: data.displayName,
      bio: data.bio ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      portfolioUrl: data.portfolioUrl ?? null,
      hourlyRate: data.hourlyRate,
      stripeAccountId: data.stripeAccountId,
    }).returning();
    return result[0];
  }

  async getPhotographer(id: string): Promise<Photographer | undefined> {
    const result = await db.select().from(photographers).where(eq(photographers.id, id));
    return result[0];
  }

  async listPhotographers(): Promise<Photographer[]> {
    return db.select().from(photographers);
  }

  async updatePhotographer(id: string, updates: Partial<Photographer>): Promise<Photographer | undefined> {
    const result = await db.update(photographers)
      .set(updates)
      .where(eq(photographers.id, id))
      .returning();
    return result[0];
  }

  async deletePhotographer(id: string): Promise<void> {
    await db.delete(photographers).where(eq(photographers.id, id));
  }

  // =========================
  // REVIEWS (Verified purchases only)
  // =========================

  async createReview(data: InsertReview): Promise<Review> {
    const id = randomUUID();
    const result = await db.insert(reviews).values({
      id,
      targetType: data.targetType,
      targetId: data.targetId,
      reviewerId: data.reviewerId,
      bookingType: data.bookingType,
      bookingId: data.bookingId,
      rating: data.rating,
      title: data.title ?? null,
      comment: data.comment ?? null,
      isVerified: true,
    }).returning();
    return result[0];
  }

  async getReviewsByTarget(targetType: string, targetId: string): Promise<Review[]> {
    return db.select().from(reviews).where(
      and(
        eq(reviews.targetType, targetType),
        eq(reviews.targetId, targetId)
      )
    );
  }

  async getReviewByBooking(bookingType: string, bookingId: string): Promise<Review | undefined> {
    const result = await db.select().from(reviews).where(
      and(
        eq(reviews.bookingType, bookingType),
        eq(reviews.bookingId, bookingId)
      )
    );
    return result[0];
  }

  async hasReviewedBooking(bookingType: string, bookingId: string): Promise<boolean> {
    const existing = await this.getReviewByBooking(bookingType, bookingId);
    return !!existing;
  }

  // Verify customer has a completed booking/order with the target
  async verifyCustomerCanReview(
    customerId: string, 
    targetType: string, 
    targetId: string, 
    bookingType: string, 
    bookingId: string
  ): Promise<{ canReview: boolean; reason?: string }> {
    
    // Check if already reviewed this booking
    const alreadyReviewed = await this.hasReviewedBooking(bookingType, bookingId);
    if (alreadyReviewed) {
      return { canReview: false, reason: 'You have already reviewed this booking' };
    }

    // Verify the booking exists and belongs to this customer
    if (bookingType === 'shoot_booking') {
      const booking = await db.select().from(shootBookings).where(
        and(
          eq(shootBookings.id, bookingId),
          eq(shootBookings.clientId, customerId),
          eq(shootBookings.photographerId, targetId),
          eq(shootBookings.status, 'completed')
        )
      );
      if (booking.length === 0) {
        return { canReview: false, reason: 'No completed shoot booking found' };
      }
    } else if (bookingType === 'appointment') {
      const booking = await db.select().from(appointments).where(
        and(
          eq(appointments.id, bookingId),
          eq(appointments.clientId, customerId),
          eq(appointments.businessId, targetId),
          eq(appointments.status, 'completed')
        )
      );
      if (booking.length === 0) {
        return { canReview: false, reason: 'No completed appointment found' };
      }
    } else if (bookingType === 'order') {
      const order = await db.select().from(orders).where(
        and(
          eq(orders.id, bookingId),
          eq(orders.customerId, customerId),
          eq(orders.businessId, targetId),
          sql`${orders.status} IN ('delivered', 'completed')`
        )
      );
      if (order.length === 0) {
        return { canReview: false, reason: 'No completed order found' };
      }
    } else {
      return { canReview: false, reason: 'Invalid booking type' };
    }

    return { canReview: true };
  }

  // Get all completed bookings/orders for a customer that can be reviewed
  async getReviewableBookings(customerId: string): Promise<{
    shootBookings: ShootBooking[];
    appointments: Appointment[];
    orders: Order[];
  }> {
    // Get completed shoot bookings without reviews
    const completedShoots = await db.select().from(shootBookings).where(
      and(
        eq(shootBookings.clientId, customerId),
        eq(shootBookings.status, 'completed')
      )
    );

    // Get completed appointments without reviews
    const completedAppointments = await db.select().from(appointments).where(
      and(
        eq(appointments.clientId, customerId),
        eq(appointments.status, 'completed')
      )
    );

    // Get completed orders without reviews
    const completedOrders = await db.select().from(orders).where(
      and(
        eq(orders.customerId, customerId),
        sql`${orders.status} IN ('delivered', 'completed')`
      )
    );

    // Filter out already reviewed items
    const reviewedBookingIds = await db.select({ bookingId: reviews.bookingId }).from(reviews).where(
      eq(reviews.reviewerId, customerId)
    );
    const reviewedIds = new Set(reviewedBookingIds.map(r => r.bookingId));

    return {
      shootBookings: completedShoots.filter(b => !reviewedIds.has(b.id)),
      appointments: completedAppointments.filter(a => !reviewedIds.has(a.id)),
      orders: completedOrders.filter(o => !reviewedIds.has(o.id)),
    };
  }

  // Update rating on target after a review
  async updateTargetRating(targetType: string, targetId: string): Promise<void> {
    const targetReviews = await this.getReviewsByTarget(targetType, targetId);
    
    if (targetReviews.length === 0) return;

    const avgRating = Math.round(
      targetReviews.reduce((sum, r) => sum + r.rating, 0) / targetReviews.length * 10
    ); // Store as 0-50 (multiplied by 10 for precision)
    
    const reviewCount = targetReviews.length;

    if (targetType === 'photographer') {
      await db.update(photographers)
        .set({ rating: avgRating, reviewCount })
        .where(eq(photographers.id, targetId));
    } else if (targetType === 'business') {
      await db.update(businesses)
        .set({ rating: avgRating, reviewCount })
        .where(eq(businesses.id, targetId));
    }
    // service_businesses would need a rating column added if needed
  }

  // =========================
  // CHAT (Real-time messaging)
  // =========================

  async getOrCreateConversation(participant1Id: string, participant2Id: string): Promise<Conversation> {
    // Check if conversation exists between these two users (check both orderings)
    const existing = await db.select().from(conversations).where(
      or(
        and(
          eq(conversations.participant1Id, participant1Id),
          eq(conversations.participant2Id, participant2Id)
        ),
        and(
          eq(conversations.participant1Id, participant2Id),
          eq(conversations.participant2Id, participant1Id)
        )
      )
    );

    if (existing.length > 0) {
      return existing[0];
    }

    // Normalize participant order to prevent duplicate conversations under concurrency
    // Always store the smaller UUID as participant1Id
    const [p1, p2] = participant1Id < participant2Id 
      ? [participant1Id, participant2Id] 
      : [participant2Id, participant1Id];

    // Create new conversation with normalized order
    const id = randomUUID();
    try {
      const result = await db.insert(conversations).values({
        id,
        participant1Id: p1,
        participant2Id: p2,
      }).returning();

      return result[0];
    } catch (error: any) {
      // Handle potential race condition - re-check for existing conversation
      if (error.code === '23505') { // Unique constraint violation
        const existingAfterRetry = await db.select().from(conversations).where(
          or(
            and(
              eq(conversations.participant1Id, p1),
              eq(conversations.participant2Id, p2)
            ),
            and(
              eq(conversations.participant1Id, p2),
              eq(conversations.participant2Id, p1)
            )
          )
        );
        if (existingAfterRetry.length > 0) {
          return existingAfterRetry[0];
        }
      }
      throw error;
    }
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const result = await db.select().from(conversations).where(eq(conversations.id, id));
    return result[0];
  }

  async getUserConversations(userId: string): Promise<(Conversation & { otherParticipant: User })[]> {
    // Get all conversations where user is a participant
    const userConvos = await db.select().from(conversations).where(
      or(
        eq(conversations.participant1Id, userId),
        eq(conversations.participant2Id, userId)
      )
    );

    // Sort by last message time (most recent first)
    userConvos.sort((a, b) => {
      const aTime = a.lastMessageAt?.getTime() || 0;
      const bTime = b.lastMessageAt?.getTime() || 0;
      return bTime - aTime;
    });

    // Enrich with other participant data
    const enriched = await Promise.all(
      userConvos.map(async (convo) => {
        const otherUserId = convo.participant1Id === userId 
          ? convo.participant2Id 
          : convo.participant1Id;
        const otherParticipant = await this.getUser(otherUserId);
        return {
          ...convo,
          otherParticipant: otherParticipant!,
        };
      })
    );

    return enriched.filter(c => c.otherParticipant);
  }

  async createMessage(data: { conversationId: string; senderId: string; content: string }): Promise<Message> {
    const id = randomUUID();
    const result = await db.insert(messages).values({
      id,
      conversationId: data.conversationId,
      senderId: data.senderId,
      content: data.content,
    }).returning();

    // Update conversation's last message info
    const preview = data.content.length > 50 
      ? data.content.substring(0, 50) + '...' 
      : data.content;
    
    await db.update(conversations)
      .set({ 
        lastMessageAt: new Date(),
        lastMessagePreview: preview,
      })
      .where(eq(conversations.id, data.conversationId));

    return result[0];
  }

  async getConversationMessages(conversationId: string, limit: number = 50, before?: string): Promise<Message[]> {
    let query;
    
    if (before) {
      // Get messages before a specific message ID (for pagination)
      const beforeMessage = await db.select().from(messages).where(eq(messages.id, before));
      if (beforeMessage.length > 0) {
        query = await db.select().from(messages).where(
          and(
            eq(messages.conversationId, conversationId),
            sql`${messages.createdAt} < ${beforeMessage[0].createdAt}`
          )
        ).limit(limit);
      } else {
        query = await db.select().from(messages)
          .where(eq(messages.conversationId, conversationId))
          .limit(limit);
      }
    } else {
      query = await db.select().from(messages)
        .where(eq(messages.conversationId, conversationId))
        .limit(limit);
    }

    // Sort by creation time (oldest first for display)
    return query.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  async markMessagesAsRead(conversationId: string, userId: string): Promise<void> {
    // Mark all messages in conversation NOT from this user as read
    await db.update(messages)
      .set({ 
        isRead: true, 
        readAt: new Date() 
      })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`${messages.senderId} != ${userId}`,
          eq(messages.isRead, false)
        )
      );
  }

  async getUnreadCount(userId: string): Promise<number> {
    // Get all conversations where user is a participant
    const userConvos = await db.select({ id: conversations.id }).from(conversations).where(
      or(
        eq(conversations.participant1Id, userId),
        eq(conversations.participant2Id, userId)
      )
    );

    if (userConvos.length === 0) return 0;

    const convoIds = userConvos.map(c => c.id);
    
    // Count unread messages not from this user
    const unread = await db.select({ count: sql<number>`count(*)` }).from(messages).where(
      and(
        sql`${messages.conversationId} IN (${sql.join(convoIds.map(id => sql`${id}`), sql`, `)})`,
        sql`${messages.senderId} != ${userId}`,
        eq(messages.isRead, false)
      )
    );

    return Number(unread[0]?.count || 0);
  }

  // =========================
  // OUTSYDE POINTS (Loyalty System)
  // =========================
  // Conversion: $1 = 100 points
  // Redemption: 100 points = $1 discount

  private readonly POINTS_PER_DOLLAR = 100;

  async getUserPointsBalance(userId: string): Promise<number> {
    const user = await this.getUser(userId);
    return user?.loyaltyPoints || 0;
  }

  async earnPoints(data: {
    userId: string;
    dollarAmountCents: number;
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<PointTransaction> {
    // Calculate points: $1 = 100 points, so cents/100 * 100 = cents
    // dollarAmountCents is in cents, so $5.00 = 500 cents = 500 points
    const pointsEarned = Math.floor(data.dollarAmountCents);
    
    // Get current balance
    const currentBalance = await this.getUserPointsBalance(data.userId);
    const newBalance = currentBalance + pointsEarned;

    // Update user's loyalty points
    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, data.userId));

    // Create transaction record
    const id = randomUUID();
    const result = await db.insert(pointTransactions).values({
      id,
      userId: data.userId,
      type: 'earn',
      points: pointsEarned,
      dollarAmountCents: data.dollarAmountCents,
      businessId: data.businessId || null,
      businessName: data.businessName || null,
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      balanceAfter: newBalance,
      description: data.description || `Earned ${pointsEarned} points`,
    }).returning();

    return result[0];
  }

  async redeemPoints(data: {
    userId: string;
    points: number;
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<{ transaction: PointTransaction; discountCents: number } | { error: string }> {
    // Check user has enough points
    const currentBalance = await this.getUserPointsBalance(data.userId);
    
    if (data.points > currentBalance) {
      return { error: `Insufficient points. You have ${currentBalance} points but tried to redeem ${data.points}` };
    }

    if (data.points <= 0) {
      return { error: 'Points to redeem must be greater than 0' };
    }

    // Calculate discount: 100 points = $1 = 100 cents
    const discountCents = this.calculatePointsValue(data.points);
    const newBalance = currentBalance - data.points;

    // Update user's loyalty points
    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, data.userId));

    // Create transaction record
    const id = randomUUID();
    const result = await db.insert(pointTransactions).values({
      id,
      userId: data.userId,
      type: 'redeem',
      points: data.points,
      dollarAmountCents: discountCents,
      businessId: data.businessId || null,
      businessName: data.businessName || null,
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      balanceAfter: newBalance,
      description: data.description || `Redeemed ${data.points} points for $${(discountCents / 100).toFixed(2)} discount`,
    }).returning();

    return { 
      transaction: result[0], 
      discountCents 
    };
  }

  async getPointTransactions(userId: string, limit: number = 50): Promise<PointTransaction[]> {
    const transactions = await db.select().from(pointTransactions)
      .where(eq(pointTransactions.userId, userId))
      .limit(limit);
    
    // Sort by creation time (most recent first)
    return transactions.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  calculatePointsValue(points: number): number {
    // 100 points = $1 = 100 cents
    return points;
  }

  // =========================
  // REFERRAL SYSTEM
  // =========================
  // Referrers and new users both get bonus points

  private readonly REFERRAL_BONUS_POINTS = 500; // $5 worth of points for referrer
  private readonly NEW_USER_REFERRAL_BONUS = 200; // $2 worth of points for new user

  async generateReferralCode(userId: string): Promise<string> {
    // Check if user already has a code
    const user = await this.getUser(userId);
    if (user?.referralCode) {
      return user.referralCode;
    }

    // Generate a unique 8-character alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded similar characters
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Ensure uniqueness
    const existing = await this.getUserByReferralCode(code);
    if (existing) {
      return this.generateReferralCode(userId); // Recursively try again
    }

    // Save the code
    await db.update(users)
      .set({ referralCode: code })
      .where(eq(users.id, userId));

    return code;
  }

  async getUserReferralCode(userId: string): Promise<string | null> {
    const user = await this.getUser(userId);
    return user?.referralCode || null;
  }

  async getUserByReferralCode(code: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      sql`UPPER(${users.referralCode}) = UPPER(${code})`
    );
    return result[0];
  }

  async processReferral(newUserId: string, referralCode: string): Promise<{ success: boolean; referrerId?: string; error?: string }> {
    // Find the referrer
    const referrer = await this.getUserByReferralCode(referralCode);
    if (!referrer) {
      return { success: false, error: 'Invalid referral code' };
    }

    // Can't refer yourself
    if (referrer.id === newUserId) {
      return { success: false, error: 'You cannot use your own referral code' };
    }

    // Check if user was already referred
    const newUser = await this.getUser(newUserId);
    if (newUser?.referredBy) {
      return { success: false, error: 'You have already used a referral code' };
    }

    // Mark the new user as referred
    await db.update(users)
      .set({ referredBy: referrer.id })
      .where(eq(users.id, newUserId));

    // Award points to referrer
    await this.earnPoints({
      userId: referrer.id,
      dollarAmountCents: this.REFERRAL_BONUS_POINTS,
      referenceType: 'referral',
      referenceId: newUserId,
      description: `Referral bonus for inviting a friend`,
    });

    // Award points to new user
    await this.earnPoints({
      userId: newUserId,
      dollarAmountCents: this.NEW_USER_REFERRAL_BONUS,
      referenceType: 'referral_welcome',
      referenceId: referrer.id,
      description: `Welcome bonus for joining via referral`,
    });

    return { success: true, referrerId: referrer.id };
  }

  // =========================
  // SEED INITIAL DATA
  // =========================

  async seedInitialData(): Promise<void> {
    const existingCities = await db.select().from(cities);
    if (existingCities.length > 0) {
      console.log("Database already seeded, skipping...");
      return;
    }

    console.log("Seeding database with initial data...");

    const demoUsers = [
      { id: "demo-owner-1", email: "demo1@outsyde.com", password: "demo", name: "Demo Owner 1", isVendor: true },
      { id: "demo-owner-2", email: "demo2@outsyde.com", password: "demo", name: "Demo Owner 2", isVendor: true },
      { id: "demo-owner-3", email: "demo3@outsyde.com", password: "demo", name: "Demo Owner 3", isVendor: true },
      { id: "demo-owner-4", email: "demo4@outsyde.com", password: "demo", name: "Demo Owner 4", isVendor: true },
      { id: "demo-owner-5", email: "demo5@outsyde.com", password: "demo", name: "Demo Owner 5", isVendor: true },
      { id: "demo-owner-6", email: "demo6@outsyde.com", password: "demo", name: "Demo Owner 6", isVendor: true },
      { id: "demo-owner-7", email: "demo7@outsyde.com", password: "demo", name: "Demo Owner 7", isVendor: true },
      { id: "demo-owner-8", email: "demo8@outsyde.com", password: "demo", name: "Demo Owner 8", isVendor: true },
    ];

    for (const demoUser of demoUsers) {
      await db.insert(users).values({
        id: demoUser.id,
        email: demoUser.email,
        password: demoUser.password,
        name: demoUser.name,
        isVendor: demoUser.isVendor,
        selectedIndustries: [],
        industryNiches: {},
      });
    }

    const majorCities: InsertCity[] = [
      {
        id: "nyc",
        name: "New York",
        state: "NY",
        businessCount: 2450,
        imageUrl: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=400&h=300&fit=crop",
        trending: true,
      },
      {
        id: "atl",
        name: "Atlanta",
        state: "GA",
        businessCount: 1820,
        imageUrl: "https://images.unsplash.com/photo-1575917649705-5b59aaa12e6b?w=400&h=300&fit=crop",
        trending: true,
      },
      {
        id: "mia",
        name: "Miami",
        state: "FL",
        businessCount: 1650,
        imageUrl: "https://images.unsplash.com/photo-1506966953602-c20cc11f75e3?w=400&h=300&fit=crop",
        trending: false,
      },
      {
        id: "la",
        name: "Los Angeles",
        state: "CA",
        businessCount: 2100,
        imageUrl: "https://images.unsplash.com/photo-1534190760961-74e8c1c5c3da?w=400&h=300&fit=crop",
        trending: true,
      },
      {
        id: "chi",
        name: "Chicago",
        state: "IL",
        businessCount: 1450,
        imageUrl: "https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=400&h=300&fit=crop",
        trending: false,
      },
      {
        id: "hou",
        name: "Houston",
        state: "TX",
        businessCount: 1380,
        imageUrl: "https://images.unsplash.com/photo-1530089711124-9ca31fb9e863?w=400&h=300&fit=crop",
        trending: false,
      },
      {
        id: "dal",
        name: "Dallas",
        state: "TX",
        businessCount: 1290,
        imageUrl: "https://images.unsplash.com/photo-1545194445-dddb8f4487c6?w=400&h=300&fit=crop",
        trending: false,
      },
      {
        id: "dc",
        name: "Washington",
        state: "DC",
        businessCount: 980,
        imageUrl: "https://images.unsplash.com/photo-1501466044931-62695aada8e9?w=400&h=300&fit=crop",
        trending: false,
      },
    ];

    for (const city of majorCities) {
      await this.createCity(city);
    }

    const sampleBusinesses: InsertBusiness[] = [
      {
        ownerId: "demo-owner-1",
        name: "Sunrise Coffee Co.",
        category: "Food & Drinks",
        description: "Artisanal coffee and fresh pastries made daily.",
        isStartup: false,
        yearsInBusiness: "3-5",
        employeeCount: "2-5",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "123 Main Street",
        city: "nyc",
        state: "NY",
        zipCode: "10001",
        websiteUrl: "https://sunrisecoffee.com",
        socialMedia: "@sunrisecoffee",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-2",
        name: "Bella's Hair Studio",
        category: "Beauty",
        description: "Expert stylists for modern cuts and colors.",
        isStartup: false,
        yearsInBusiness: "5-10",
        employeeCount: "6-10",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "456 Style Ave",
        city: "nyc",
        state: "NY",
        zipCode: "10002",
        socialMedia: "@bellashair",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-3",
        name: "Artisan Jewelry Co.",
        category: "Shopping",
        description: "Handcrafted jewelry for every occasion.",
        isStartup: true,
        yearsInBusiness: "1-2",
        employeeCount: "just-me",
        businessType: "sole-proprietor",
        hasPhysicalLocation: true,
        address: "789 Arts District",
        city: "atl",
        state: "GA",
        zipCode: "30301",
        websiteUrl: "https://artisanjewelry.co",
        socialMedia: "@artisanjewelry",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-4",
        name: "Zen Yoga Studio",
        category: "Health",
        description: "Expert-led yoga and meditation classes.",
        isStartup: false,
        yearsInBusiness: "3-5",
        employeeCount: "6-10",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "321 Wellness Way",
        city: "la",
        state: "CA",
        zipCode: "90001",
        websiteUrl: "https://zenyoga.com",
        socialMedia: "@zenyogala",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-5",
        name: "Green Valley Organics",
        category: "Food & Drinks",
        description: "Fresh organic produce from local farms.",
        isStartup: false,
        yearsInBusiness: "5-10",
        employeeCount: "11-25",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "555 Market Street",
        city: "mia",
        state: "FL",
        zipCode: "33101",
        socialMedia: "@greenvalleyorganics",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-6",
        name: "Urban Cuts Barbershop",
        category: "Beauty",
        description: "Classic cuts and modern styles for men.",
        isStartup: false,
        yearsInBusiness: "10+",
        employeeCount: "2-5",
        businessType: "sole-proprietor",
        hasPhysicalLocation: true,
        address: "222 Main Street",
        city: "atl",
        state: "GA",
        zipCode: "30302",
        socialMedia: "@urbancuts",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-7",
        name: "Soul Food Kitchen",
        category: "Food & Drinks",
        description: "Authentic southern comfort food made with love.",
        isStartup: false,
        yearsInBusiness: "10+",
        employeeCount: "6-10",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "100 Peachtree Street",
        city: "atl",
        state: "GA",
        zipCode: "30303",
        websiteUrl: "https://soulfoodkitchen.com",
        socialMedia: "@soulfoodkitchen",
        subscriptionActive: true,
      },
      {
        ownerId: "demo-owner-8",
        name: "Beach Vibes Boutique",
        category: "Shopping",
        description: "Trendy beachwear and accessories.",
        isStartup: true,
        yearsInBusiness: "less-than-1",
        employeeCount: "2-5",
        businessType: "llc",
        hasPhysicalLocation: true,
        address: "888 Ocean Drive",
        city: "mia",
        state: "FL",
        zipCode: "33102",
        websiteUrl: "https://beachvibes.com",
        socialMedia: "@beachvibesboutique",
        subscriptionActive: true,
      },
    ];

    for (const business of sampleBusinesses) {
      await db.insert(businesses).values({
        id: randomUUID(),
        ...business,
        coverImage: null,
        logoImage: null,
        rating: Math.floor(Math.random() * 5 + 45),
        reviewCount: Math.floor(Math.random() * 200 + 50),
      }).returning();
    }

    console.log("Database seeded successfully!");
  }
}

export const storage = new DatabaseStorage();
