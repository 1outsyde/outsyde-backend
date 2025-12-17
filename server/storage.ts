import { 
  type User, 
  type InsertUser, 
  type UpsertUser,
  type Business, 
  type InsertBusiness,
  type UpdateBusinessProfile,
  type City,
  type InsertCity,
  type RefreshToken,
  type Photographer,
  type PhotographerService,
  type InsertPhotographerService,
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
  type PushSubscription,
  type InsertPushSubscription,
  type CartItem,
  type InsertCartItem,
  type VendorSubscription,
  type TierBenefit,
  type BenefitAllowance,
  type FulfillmentTask,
  type AlaCarteService,
  type AlaCartePurchase,
  type SubscriptionTier,
  type VendorProduct,
  type InsertVendorProduct,
  type VendorService,
  type InsertVendorService,
  type RefundRequest,
  type InsertRefundRequest,
  type AvailabilitySlot,
  type InsertAvailabilitySlot,
  type Scheduling,
  type InsertScheduling,
  type FeedPost,
  type InsertFeedPost,
  type PostComment,
  type InsertPostComment,
  type ProfileComment,
  type InsertProfileComment,
  users,
  businesses,
  cities,
  refreshTokens,
  photographers,
  photographerServices,
  reviews,
  shootBookings,
  appointments,
  orders,
  conversations,
  messages,
  pointTransactions,
  pushSubscriptions,
  cartItems,
  vendorSubscriptions,
  subscriptionTiers,
  tierBenefits,
  benefitAllowances,
  benefitUsage,
  fulfillmentTasks,
  alaCarteServices,
  alaCartePurchases,
  vendorProducts,
  vendorServices,
  refundRequests,
  availabilitySlots,
  scheduling,
  feedPosts,
  postLikes,
  postComments,
  profileComments
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
  stripeAccountId?: string | null;
  specialties?: string[];
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
  getPhotographerByUserId(userId: string): Promise<Photographer | undefined>;
  listPhotographers(): Promise<Photographer[]>;
  updatePhotographer(id: string, updates: Partial<Photographer>): Promise<Photographer | undefined>;
  deletePhotographer(id: string): Promise<void>;

  // Photographer Services CRUD
  createPhotographerService(data: InsertPhotographerService): Promise<PhotographerService>;
  getPhotographerService(id: string): Promise<PhotographerService | undefined>;
  getPhotographerServices(photographerId: string): Promise<PhotographerService[]>;
  updatePhotographerService(id: string, updates: Partial<PhotographerService>): Promise<PhotographerService | undefined>;
  deletePhotographerService(id: string): Promise<void>;

  // Reviews (verified purchases only)
  createReview(data: InsertReview): Promise<Review>;
  getReviewsByTarget(targetType: string, targetId: string): Promise<Review[]>;
  getReviewByBooking(bookingType: string, bookingId: string): Promise<Review | undefined>;
  hasReviewedBooking(bookingType: string, bookingId: string): Promise<boolean>;
  verifyCustomerCanReview(customerId: string, targetType: string, targetId: string, bookingType: string, bookingId: string): Promise<{ canReview: boolean; reason?: string }>;
  getReviewableBookings(customerId: string): Promise<{ shootBookings: ShootBooking[]; appointments: Appointment[]; orders: Order[] }>;
  updateTargetRating(targetType: string, targetId: string): Promise<void>;

  // Business Customers
  getBusinessOrderRecords(businessId: string): Promise<{
    recordId: string;
    recordType: 'order' | 'appointment';
    customerId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    productsOrServices: string;
    orderedAt: Date | null;
    bookingDateTime: string | null;
    totalPaid: number;
    platformFee: number;
    vendorNet: number;
    paymentIntentId: string | null;
    status: string | null;
  }[]>;
  getPhotographerBookingRecords(photographerId: string): Promise<{
    recordId: string;
    clientId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    shootType: string;
    serviceName: string | null;
    serviceId: string | null;
    locationDetails: string | null;
    specialRequests: string | null;
    orderedAt: Date | null;
    bookingDateTime: string;
    totalPaid: number;
    platformFee: number;
    vendorNet: number;
    paymentIntentId: string | null;
    status: string | null;
  }[]>;
  createShootBooking(data: {
    photographerId: string;
    clientId: string;
    serviceId?: string | null;
    shootType: string;
    date: string;
    startTime: string;
    endTime: string;
    durationHours: number;
    locationType?: string | null;
    locationDetails?: string | null;
    specialRequests?: string | null;
    totalPrice: number;
    platformFee: number;
    vendorNet: number;
    status?: string;
  }): Promise<ShootBooking>;

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

  // Push Subscriptions (Browser Push Notifications)
  savePushSubscription(data: InsertPushSubscription): Promise<PushSubscription>;
  getPushSubscription(userId: string, endpoint: string): Promise<PushSubscription | undefined>;
  getUserPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  deletePushSubscription(userId: string, endpoint: string): Promise<void>;
  getAllPushSubscriptions(): Promise<PushSubscription[]>;

  // Cart Items (Persistent Shopping Cart)
  getCartItems(userId: string): Promise<CartItem[]>;
  addCartItem(data: InsertCartItem): Promise<CartItem>;
  updateCartItemQuantity(id: string, quantity: number): Promise<CartItem | undefined>;
  removeCartItem(id: string): Promise<void>;
  clearCart(userId: string): Promise<void>;
  getUsersWithAbandonedCarts(hoursAgo: number): Promise<{ userId: string; items: CartItem[] }[]>;

  // Vendor Subscriptions & Benefits
  createVendorSubscription(data: { vendorId: string; businessId: string; tierId: string; stripeCustomerId?: string; stripeSubscriptionId?: string }): Promise<VendorSubscription>;
  getVendorSubscription(vendorId: string): Promise<VendorSubscription | undefined>;
  getVendorSubscriptionByStripeId(stripeSubscriptionId: string): Promise<VendorSubscription | undefined>;
  updateVendorSubscription(id: string, updates: Partial<VendorSubscription>): Promise<VendorSubscription | undefined>;
  getTierBenefits(tierId: string): Promise<TierBenefit[]>;
  createBenefitAllowances(subscriptionId: string, overrideCycleDates?: { periodStart: Date; periodEnd: Date; quarterStart: Date; quarterEnd: Date }): Promise<BenefitAllowance[]>;
  renewBenefitAllowancesForNewCycle(): Promise<number>;
  getVendorBenefitAllowances(vendorId: string): Promise<(BenefitAllowance & { benefit: TierBenefit })[]>;
  useBenefit(allowanceId: string, vendorId: string, businessId: string, notes?: string): Promise<{ success: boolean; allowance?: BenefitAllowance; task?: FulfillmentTask; error?: string }>;
  expireOldAllowances(): Promise<number>;

  // À la carte services
  getAlaCarteServices(): Promise<AlaCarteService[]>;
  getAlaCarteService(id: string): Promise<AlaCarteService | undefined>;
  getAlaCarteServicePricing(serviceId: string, vendorId: string): Promise<{ service: AlaCarteService; tier: SubscriptionTier | null; basePriceCents: number; discountPercent: number; finalPriceCents: number } | null>;
  createAlaCartePurchase(data: {
    vendorId: string;
    businessId: string;
    serviceId: string;
    tierIdAtPurchase: string | null;
    basePriceInCents: number;
    discountPercent: number;
    finalPriceInCents: number;
    platformFeeInCents: number;
    stripeCheckoutSessionId?: string;
  }): Promise<AlaCartePurchase>;
  getAlaCartePurchase(id: string): Promise<AlaCartePurchase | undefined>;
  getAlaCartePurchaseByCheckoutSession(sessionId: string): Promise<AlaCartePurchase | undefined>;
  updateAlaCartePurchase(id: string, updates: Partial<AlaCartePurchase>): Promise<AlaCartePurchase | undefined>;
  getVendorAlaCartePurchases(vendorId: string): Promise<AlaCartePurchase[]>;

  // Vendor Storefront - Products
  getVendorProducts(businessId: string): Promise<VendorProduct[]>;
  getVendorProduct(id: string): Promise<VendorProduct | undefined>;
  createVendorProduct(data: InsertVendorProduct): Promise<VendorProduct>;
  updateVendorProduct(id: string, updates: Partial<VendorProduct>): Promise<VendorProduct | undefined>;
  deleteVendorProduct(id: string): Promise<void>;

  // Vendor Storefront - Services
  getVendorServicesByBusiness(businessId: string): Promise<VendorService[]>;
  getVendorService(id: string): Promise<VendorService | undefined>;
  createVendorService(data: InsertVendorService): Promise<VendorService>;
  updateVendorService(id: string, updates: Partial<VendorService>): Promise<VendorService | undefined>;
  deleteVendorService(id: string): Promise<void>;

  // Refund Requests
  createRefundRequest(data: InsertRefundRequest): Promise<RefundRequest>;
  getRefundRequest(id: string): Promise<RefundRequest | undefined>;
  getRefundRequestsByRequester(requesterId: string): Promise<RefundRequest[]>;
  getRefundRequestsByTarget(targetType: string, targetId: string): Promise<RefundRequest[]>;
  getAllPendingRefundRequests(): Promise<(RefundRequest & { requesterName: string | null; requesterEmail: string | null })[]>;
  updateRefundRequest(id: string, updates: Partial<RefundRequest>): Promise<RefundRequest | undefined>;

  // Availability Slots
  getAvailabilitySlots(providerType: string, providerId: string): Promise<AvailabilitySlot[]>;
  createAvailabilitySlot(data: InsertAvailabilitySlot): Promise<AvailabilitySlot>;
  updateAvailabilitySlot(id: string, updates: Partial<AvailabilitySlot>): Promise<AvailabilitySlot | undefined>;
  deleteAvailabilitySlot(id: string): Promise<void>;

  // Scheduling (Unconfirmed Bookings)
  createScheduling(data: InsertScheduling): Promise<Scheduling>;
  getScheduling(id: string): Promise<Scheduling | undefined>;
  getSchedulingByProvider(providerType: string, providerId: string): Promise<Scheduling[]>;
  getSchedulingByClient(clientId: string): Promise<Scheduling[]>;
  updateScheduling(id: string, updates: Partial<Scheduling>): Promise<Scheduling | undefined>;

  // Feed Posts
  createFeedPost(data: InsertFeedPost): Promise<FeedPost>;
  getFeedPost(id: string): Promise<FeedPost | undefined>;
  getFeedPosts(limit?: number, offset?: number): Promise<FeedPost[]>;
  getUserFeedPosts(authorId: string): Promise<FeedPost[]>;
  getBusinessFeedPosts(businessId: string): Promise<FeedPost[]>;
  getPhotographerFeedPosts(photographerId: string): Promise<FeedPost[]>;
  deleteFeedPost(id: string): Promise<void>;
  likePost(postId: string, userId: string): Promise<boolean>;
  unlikePost(postId: string, userId: string): Promise<boolean>;
  hasUserLikedPost(postId: string, userId: string): Promise<boolean>;
  addPostComment(data: InsertPostComment): Promise<PostComment>;
  getPostComments(postId: string): Promise<PostComment[]>;
  canCustomerTagBusiness(customerId: string, businessId: string): Promise<boolean>;
  canCustomerTagPhotographer(customerId: string, photographerId: string): Promise<boolean>;

  // Profile Comments (for businesses and photographers)
  createProfileComment(data: InsertProfileComment): Promise<ProfileComment>;
  getProfileComments(targetType: string, targetId: string): Promise<(ProfileComment & { authorName: string | null; authorImage: string | null })[]>;

  // Unified Search
  searchAll(filters?: { city?: string; category?: string; search?: string }): Promise<{
    businesses: Business[];
    photographers: Photographer[];
  }>;

  // Admin Dashboard Methods
  getAllUsers(): Promise<User[]>;
  getAllBusinesses(): Promise<Business[]>;
  getAllPhotographers(): Promise<Photographer[]>;
  getAllOrders(): Promise<Order[]>;
  getAllShootBookings(): Promise<ShootBooking[]>;
  getAllConversations(): Promise<Conversation[]>;
  getUserOrders(userId: string): Promise<Order[]>;
  getUserBookings(userId: string): Promise<ShootBooking[]>;
  getVendorOrders(businessId: string): Promise<Order[]>;
  getPhotographerBookings(photographerId: string): Promise<ShootBooking[]>;
  getMessages(conversationId: string): Promise<Message[]>;

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
      isPhotographer: insertUser.isPhotographer ?? false,

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
      hasProducts: insertBusiness.hasProducts ?? false,
      hasServices: insertBusiness.hasServices ?? false,
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
      stripeAccountId: data.stripeAccountId ?? null,
      stripeOnboardingComplete: false,
      specialties: data.specialties ?? [],
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

  async getPhotographerByUserId(userId: string): Promise<Photographer | undefined> {
    const result = await db.select().from(photographers).where(eq(photographers.userId, userId));
    return result[0];
  }

  // =========================
  // PHOTOGRAPHER SERVICES
  // =========================

  async createPhotographerService(data: InsertPhotographerService): Promise<PhotographerService> {
    const result = await db.insert(photographerServices).values({
      ...data,
      id: randomUUID(),
    }).returning();
    return result[0];
  }

  async getPhotographerService(id: string): Promise<PhotographerService | undefined> {
    const result = await db.select().from(photographerServices).where(eq(photographerServices.id, id));
    return result[0];
  }

  async getPhotographerServices(photographerId: string): Promise<PhotographerService[]> {
    return db.select()
      .from(photographerServices)
      .where(and(
        eq(photographerServices.photographerId, photographerId),
        eq(photographerServices.isActive, true)
      ));
  }

  async updatePhotographerService(id: string, updates: Partial<PhotographerService>): Promise<PhotographerService | undefined> {
    const result = await db.update(photographerServices)
      .set(updates)
      .where(eq(photographerServices.id, id))
      .returning();
    return result[0];
  }

  async deletePhotographerService(id: string): Promise<void> {
    await db.update(photographerServices)
      .set({ isActive: false })
      .where(eq(photographerServices.id, id));
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

  // Get all order/booking records for a business with customer details
  async getBusinessOrderRecords(businessId: string): Promise<{
    recordId: string;
    recordType: 'order' | 'appointment';
    customerId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    productsOrServices: string;
    orderedAt: Date | null;
    bookingDateTime: string | null;
    totalPaid: number;
    platformFee: number;
    vendorNet: number;
    paymentIntentId: string | null;
    status: string | null;
  }[]> {
    // Get orders with customer info
    const orderRecords = await db.select({
      recordId: orders.id,
      customerId: orders.customerId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      items: orders.items,
      orderedAt: orders.createdAt,
      totalPaid: orders.totalAmount,
      platformFee: orders.platformFee,
      vendorNet: orders.vendorNet,
      paymentIntentId: orders.stripePaymentIntentId,
      status: orders.status,
    })
      .from(orders)
      .leftJoin(users, eq(orders.customerId, users.id))
      .where(eq(orders.businessId, businessId))
      .orderBy(sql`${orders.createdAt} DESC`);

    // Get appointments with customer and service info
    const appointmentRecords = await db.select({
      recordId: appointments.id,
      customerId: appointments.clientId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      serviceTitle: vendorServices.name,
      appointmentDate: appointments.appointmentDate,
      appointmentTime: appointments.appointmentTime,
      orderedAt: appointments.createdAt,
      totalPaid: appointments.totalPrice,
      platformFee: appointments.platformFee,
      vendorNet: appointments.vendorNet,
      paymentIntentId: appointments.stripePaymentIntentId,
      status: appointments.status,
    })
      .from(appointments)
      .leftJoin(users, eq(appointments.clientId, users.id))
      .leftJoin(vendorServices, eq(appointments.serviceId, vendorServices.id))
      .where(eq(appointments.businessId, businessId))
      .orderBy(sql`${appointments.createdAt} DESC`);

    // Format orders
    const formattedOrders = orderRecords.map(o => ({
      recordId: o.recordId,
      recordType: 'order' as const,
      customerId: o.customerId,
      firstName: o.firstName,
      lastName: o.lastName,
      email: o.email,
      productsOrServices: (o.items as any[]).map((i: any) => `${i.name} x${i.quantity}`).join(', '),
      orderedAt: o.orderedAt,
      bookingDateTime: null,
      totalPaid: o.totalPaid,
      platformFee: o.platformFee || 0,
      vendorNet: o.vendorNet || 0,
      paymentIntentId: o.paymentIntentId,
      status: o.status,
    }));

    // Format appointments
    const formattedAppointments = appointmentRecords.map(a => ({
      recordId: a.recordId,
      recordType: 'appointment' as const,
      customerId: a.customerId,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      productsOrServices: a.serviceTitle || 'Service',
      orderedAt: a.orderedAt,
      bookingDateTime: `${a.appointmentDate} ${a.appointmentTime}`,
      totalPaid: a.totalPaid,
      platformFee: a.platformFee || 0,
      vendorNet: a.vendorNet || 0,
      paymentIntentId: a.paymentIntentId,
      status: a.status,
    }));

    // Combine and sort by orderedAt
    return [...formattedOrders, ...formattedAppointments].sort((a, b) => {
      const dateA = a.orderedAt ? new Date(a.orderedAt).getTime() : 0;
      const dateB = b.orderedAt ? new Date(b.orderedAt).getTime() : 0;
      return dateB - dateA;
    });
  }

  // Get all shoot booking records for a photographer with client details
  async getPhotographerBookingRecords(photographerId: string): Promise<{
    recordId: string;
    clientId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    shootType: string;
    serviceName: string | null;
    serviceId: string | null;
    locationDetails: string | null;
    specialRequests: string | null;
    orderedAt: Date | null;
    bookingDateTime: string;
    totalPaid: number;
    platformFee: number;
    vendorNet: number;
    paymentIntentId: string | null;
    status: string | null;
  }[]> {
    const bookingRecords = await db.select({
      recordId: shootBookings.id,
      clientId: shootBookings.clientId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      shootType: shootBookings.shootType,
      serviceId: shootBookings.serviceId,
      serviceName: photographerServices.name,
      locationDetails: shootBookings.locationDetails,
      specialRequests: shootBookings.specialRequests,
      orderedAt: shootBookings.createdAt,
      date: shootBookings.date,
      startTime: shootBookings.startTime,
      totalPaid: shootBookings.totalPrice,
      platformFee: shootBookings.platformFee,
      vendorNet: shootBookings.vendorNet,
      paymentIntentId: shootBookings.stripePaymentIntentId,
      status: shootBookings.status,
    })
      .from(shootBookings)
      .leftJoin(users, eq(shootBookings.clientId, users.id))
      .leftJoin(photographerServices, eq(shootBookings.serviceId, photographerServices.id))
      .where(eq(shootBookings.photographerId, photographerId))
      .orderBy(sql`${shootBookings.createdAt} DESC`);

    return bookingRecords.map(b => ({
      recordId: b.recordId,
      clientId: b.clientId,
      firstName: b.firstName,
      lastName: b.lastName,
      email: b.email,
      shootType: b.shootType,
      serviceName: b.serviceName,
      serviceId: b.serviceId,
      locationDetails: b.locationDetails,
      specialRequests: b.specialRequests,
      orderedAt: b.orderedAt,
      bookingDateTime: `${b.date} ${b.startTime}`,
      totalPaid: b.totalPaid,
      platformFee: b.platformFee || 0,
      vendorNet: b.vendorNet || 0,
      paymentIntentId: b.paymentIntentId,
      status: b.status,
    }));
  }

  // Create a new shoot booking
  async createShootBooking(data: {
    photographerId: string;
    clientId: string;
    serviceId?: string | null;
    shootType: string;
    date: string;
    startTime: string;
    endTime: string;
    durationHours: number;
    locationType?: string | null;
    locationDetails?: string | null;
    specialRequests?: string | null;
    totalPrice: number;
    platformFee: number;
    vendorNet: number;
    status?: string;
  }): Promise<ShootBooking> {
    const [booking] = await db
      .insert(shootBookings)
      .values({
        photographerId: data.photographerId,
        clientId: data.clientId,
        serviceId: data.serviceId || null,
        shootType: data.shootType,
        date: data.date,
        startTime: data.startTime,
        endTime: data.endTime,
        durationHours: data.durationHours,
        locationType: data.locationType || null,
        locationDetails: data.locationDetails || null,
        specialRequests: data.specialRequests || null,
        totalPrice: data.totalPrice,
        platformFee: data.platformFee,
        vendorNet: data.vendorNet,
        status: data.status || "pending",
      })
      .returning();
    return booking;
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
  // ADMIN DASHBOARD METHODS
  // =========================

  async getAllUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getAllBusinesses(): Promise<Business[]> {
    return db.select().from(businesses);
  }

  async getAllPhotographers(): Promise<Photographer[]> {
    return db.select().from(photographers);
  }

  async getAllOrders(): Promise<Order[]> {
    return db.select().from(orders);
  }

  async getAllShootBookings(): Promise<ShootBooking[]> {
    return db.select().from(shootBookings);
  }

  async getAllConversations(): Promise<Conversation[]> {
    return db.select().from(conversations);
  }

  async getUserOrders(userId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.userId, userId));
  }

  async getUserBookings(userId: string): Promise<ShootBooking[]> {
    return db.select().from(shootBookings).where(eq(shootBookings.customerId, userId));
  }

  async getVendorOrders(businessId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.businessId, businessId));
  }

  async getPhotographerBookings(photographerId: string): Promise<ShootBooking[]> {
    return db.select().from(shootBookings).where(eq(shootBookings.photographerId, photographerId));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId));
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

  // ================================
  // PUSH SUBSCRIPTIONS
  // ================================

  async savePushSubscription(data: InsertPushSubscription): Promise<PushSubscription> {
    const existing = await this.getPushSubscription(data.userId, data.endpoint);
    if (existing) {
      const [updated] = await db
        .update(pushSubscriptions)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(pushSubscriptions.id, existing.id))
        .returning();
      return updated;
    }
    
    const [subscription] = await db
      .insert(pushSubscriptions)
      .values(data)
      .returning();
    return subscription;
  }

  async getPushSubscription(userId: string, endpoint: string): Promise<PushSubscription | undefined> {
    const [subscription] = await db
      .select()
      .from(pushSubscriptions)
      .where(and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint)
      ));
    return subscription;
  }

  async getUserPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    return db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
    await db
      .delete(pushSubscriptions)
      .where(and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint)
      ));
  }

  async getAllPushSubscriptions(): Promise<PushSubscription[]> {
    return db.select().from(pushSubscriptions);
  }

  // ================================
  // CART ITEMS
  // ================================

  async getCartItems(userId: string): Promise<CartItem[]> {
    return db
      .select()
      .from(cartItems)
      .where(eq(cartItems.userId, userId))
      .orderBy(cartItems.createdAt);
  }

  async addCartItem(data: InsertCartItem): Promise<CartItem> {
    const existing = await db
      .select()
      .from(cartItems)
      .where(and(
        eq(cartItems.userId, data.userId),
        eq(cartItems.productId, data.productId)
      ));
    
    if (existing.length > 0) {
      const [updated] = await db
        .update(cartItems)
        .set({ 
          quantity: existing[0].quantity + (data.quantity || 1),
          updatedAt: new Date()
        })
        .where(eq(cartItems.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [item] = await db.insert(cartItems).values(data).returning();
    return item;
  }

  async updateCartItemQuantity(id: string, quantity: number): Promise<CartItem | undefined> {
    if (quantity <= 0) {
      await this.removeCartItem(id);
      return undefined;
    }
    
    const [updated] = await db
      .update(cartItems)
      .set({ quantity, updatedAt: new Date() })
      .where(eq(cartItems.id, id))
      .returning();
    return updated;
  }

  async removeCartItem(id: string): Promise<void> {
    await db.delete(cartItems).where(eq(cartItems.id, id));
  }

  async clearCart(userId: string): Promise<void> {
    await db.delete(cartItems).where(eq(cartItems.userId, userId));
  }

  async getUsersWithAbandonedCarts(hoursAgo: number): Promise<{ userId: string; items: CartItem[] }[]> {
    const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    
    const items = await db
      .select()
      .from(cartItems)
      .where(sql`${cartItems.updatedAt} < ${cutoffTime}`);
    
    const grouped: Record<string, CartItem[]> = {};
    for (const item of items) {
      if (!grouped[item.userId]) {
        grouped[item.userId] = [];
      }
      grouped[item.userId].push(item);
    }
    
    return Object.entries(grouped).map(([userId, items]) => ({ userId, items }));
  }

  // =========================
  // VENDOR SUBSCRIPTIONS & BENEFITS
  // =========================

  async createVendorSubscription(data: { 
    vendorId: string; 
    businessId: string; 
    tierId: string; 
    stripeCustomerId?: string; 
    stripeSubscriptionId?: string 
  }): Promise<VendorSubscription> {
    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const quarterEnd = this.getQuarterEnd(now);
    
    const [subscription] = await db.insert(vendorSubscriptions).values({
      vendorId: data.vendorId,
      businessId: data.businessId,
      tierId: data.tierId,
      stripeCustomerId: data.stripeCustomerId || null,
      stripeSubscriptionId: data.stripeSubscriptionId || null,
      status: 'pending',
      currentPeriodStart: now,
      currentPeriodEnd: monthEnd,
      currentQuarterStart: this.getQuarterStart(now),
      currentQuarterEnd: quarterEnd,
    }).returning();
    return subscription;
  }

  private getQuarterStart(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), quarter * 3, 1);
  }

  private getQuarterEnd(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), (quarter + 1) * 3, 0, 23, 59, 59);
  }

  async getVendorSubscription(vendorId: string): Promise<VendorSubscription | undefined> {
    const [subscription] = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.vendorId, vendorId));
    return subscription;
  }

  async getVendorSubscriptionByStripeId(stripeSubscriptionId: string): Promise<VendorSubscription | undefined> {
    const [subscription] = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.stripeSubscriptionId, stripeSubscriptionId));
    return subscription;
  }

  async updateVendorSubscription(id: string, updates: Partial<VendorSubscription>): Promise<VendorSubscription | undefined> {
    const [updated] = await db.update(vendorSubscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(vendorSubscriptions.id, id))
      .returning();
    return updated;
  }

  async getTierBenefits(tierId: string): Promise<TierBenefit[]> {
    return db.select()
      .from(tierBenefits)
      .where(eq(tierBenefits.tierId, tierId));
  }

  async createBenefitAllowances(subscriptionId: string, overrideCycleDates?: { periodStart: Date; periodEnd: Date; quarterStart: Date; quarterEnd: Date }): Promise<BenefitAllowance[]> {
    // Fetch fresh subscription data
    const [subscription] = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.id, subscriptionId));
    
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const benefits = await this.getTierBenefits(subscription.tierId);
    const allowances: BenefitAllowance[] = [];
    const now = new Date();

    // Use override dates if provided, otherwise use stored subscription dates, then fallback to calendar
    const periodStart = overrideCycleDates?.periodStart || subscription.currentPeriodStart || now;
    const periodEnd = overrideCycleDates?.periodEnd || subscription.currentPeriodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const quarterStart = overrideCycleDates?.quarterStart || subscription.currentQuarterStart || this.getQuarterStart(periodStart);
    const quarterEnd = overrideCycleDates?.quarterEnd || subscription.currentQuarterEnd || this.getQuarterEnd(periodStart);

    for (const benefit of benefits) {
      // Use appropriate dates based on cycle type
      let cycleStart: Date;
      let cycleEnd: Date;
      
      if (benefit.cycleType === 'monthly') {
        cycleStart = periodStart;
        cycleEnd = periodEnd;
      } else {
        cycleStart = quarterStart;
        cycleEnd = quarterEnd;
      }

      // Check if allowance already exists for this benefit and cycle (idempotency)
      const existing = await db.select()
        .from(benefitAllowances)
        .where(and(
          eq(benefitAllowances.subscriptionId, subscriptionId),
          eq(benefitAllowances.benefitId, benefit.id),
          eq(benefitAllowances.cycleStart, cycleStart),
          eq(benefitAllowances.isExpired, false)
        ));
      
      if (existing.length > 0) {
        allowances.push(existing[0]);
        continue;
      }

      // Expire any previous non-expired allowances for this benefit before creating new one
      await db.update(benefitAllowances)
        .set({ isExpired: true, expiredAt: now })
        .where(and(
          eq(benefitAllowances.subscriptionId, subscriptionId),
          eq(benefitAllowances.benefitId, benefit.id),
          eq(benefitAllowances.isExpired, false)
        ));

      const [allowance] = await db.insert(benefitAllowances).values({
        subscriptionId,
        benefitId: benefit.id,
        cycleType: benefit.cycleType,
        cycleStart,
        cycleEnd,
        totalQuantity: benefit.includedQuantity,
        usedQuantity: 0,
        remainingQuantity: benefit.includedQuantity,
      }).returning();
      
      allowances.push(allowance);
    }

    return allowances;
  }

  async renewBenefitAllowancesForNewCycle(): Promise<number> {
    // Note: This is a backup/fallback method. Primary renewal happens via invoice.paid webhook.
    // This method uses stored subscription cycle dates for consistency with Stripe.
    
    const activeSubscriptions = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.status, 'active'));
    
    let createdCount = 0;

    for (const subscription of activeSubscriptions) {
      // Skip if subscription doesn't have stored cycle dates (wait for webhook to set them)
      if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
        continue;
      }

      const benefits = await this.getTierBenefits(subscription.tierId);
      
      for (const benefit of benefits) {
        // Use subscription's stored Stripe billing cycle dates
        let cycleStart: Date;
        let cycleEnd: Date;
        
        if (benefit.cycleType === 'monthly') {
          cycleStart = subscription.currentPeriodStart;
          cycleEnd = subscription.currentPeriodEnd;
        } else {
          // Quarterly benefits use the quarterly dates
          cycleStart = subscription.currentQuarterStart || this.getQuarterStart(subscription.currentPeriodStart);
          cycleEnd = subscription.currentQuarterEnd || this.getQuarterEnd(subscription.currentPeriodStart);
        }

        // Check if allowance exists for current cycle (idempotency check)
        const existing = await db.select()
          .from(benefitAllowances)
          .where(and(
            eq(benefitAllowances.subscriptionId, subscription.id),
            eq(benefitAllowances.benefitId, benefit.id),
            eq(benefitAllowances.cycleStart, cycleStart),
            eq(benefitAllowances.isExpired, false)
          ));
        
        if (existing.length === 0) {
          // Expire old allowances before creating new
          const now = new Date();
          await db.update(benefitAllowances)
            .set({ isExpired: true, expiredAt: now })
            .where(and(
              eq(benefitAllowances.subscriptionId, subscription.id),
              eq(benefitAllowances.benefitId, benefit.id),
              eq(benefitAllowances.isExpired, false)
            ));

          await db.insert(benefitAllowances).values({
            subscriptionId: subscription.id,
            benefitId: benefit.id,
            cycleType: benefit.cycleType,
            cycleStart,
            cycleEnd,
            totalQuantity: benefit.includedQuantity,
            usedQuantity: 0,
            remainingQuantity: benefit.includedQuantity,
          });
          createdCount++;
        }
      }
    }

    return createdCount;
  }

  async getVendorBenefitAllowances(vendorId: string): Promise<(BenefitAllowance & { benefit: TierBenefit })[]> {
    const subscription = await this.getVendorSubscription(vendorId);
    if (!subscription) {
      return [];
    }

    const allowanceRows = await db.select()
      .from(benefitAllowances)
      .where(and(
        eq(benefitAllowances.subscriptionId, subscription.id),
        eq(benefitAllowances.isExpired, false)
      ));

    const result: (BenefitAllowance & { benefit: TierBenefit })[] = [];
    for (const allowance of allowanceRows) {
      const [benefit] = await db.select()
        .from(tierBenefits)
        .where(eq(tierBenefits.id, allowance.benefitId));
      if (benefit) {
        result.push({ ...allowance, benefit });
      }
    }

    return result;
  }

  async useBenefit(
    allowanceId: string, 
    vendorId: string, 
    businessId: string, 
    notes?: string
  ): Promise<{ success: boolean; allowance?: BenefitAllowance; task?: FulfillmentTask; error?: string }> {
    const [allowance] = await db.select()
      .from(benefitAllowances)
      .where(eq(benefitAllowances.id, allowanceId));

    if (!allowance) {
      return { success: false, error: 'Allowance not found' };
    }

    if (allowance.isExpired) {
      return { success: false, error: 'Benefit has expired' };
    }

    if (allowance.remainingQuantity <= 0) {
      return { success: false, error: 'No remaining uses for this benefit' };
    }

    const now = new Date();
    if (now > allowance.cycleEnd) {
      return { success: false, error: 'Benefit cycle has ended' };
    }

    const [benefit] = await db.select()
      .from(tierBenefits)
      .where(eq(tierBenefits.id, allowance.benefitId));

    if (!benefit) {
      return { success: false, error: 'Benefit definition not found' };
    }

    const [updatedAllowance] = await db.update(benefitAllowances)
      .set({
        usedQuantity: allowance.usedQuantity + 1,
        remainingQuantity: allowance.remainingQuantity - 1,
      })
      .where(eq(benefitAllowances.id, allowanceId))
      .returning();

    await db.insert(benefitUsage).values({
      allowanceId,
      benefitType: benefit.benefitType,
      quantityUsed: 1,
      notes,
    });

    let task: FulfillmentTask | undefined;
    if (benefit.requiresAdminFulfillment) {
      const [newTask] = await db.insert(fulfillmentTasks).values({
        vendorId,
        businessId,
        taskType: benefit.benefitType,
        sourceType: 'benefit',
        sourceId: allowanceId,
        status: 'pending',
        vendorNotes: notes,
      }).returning();
      task = newTask;
    }

    return { success: true, allowance: updatedAllowance, task };
  }

  async expireOldAllowances(): Promise<number> {
    const now = new Date();
    const result = await db.update(benefitAllowances)
      .set({ isExpired: true, expiredAt: now })
      .where(and(
        eq(benefitAllowances.isExpired, false),
        sql`${benefitAllowances.cycleEnd} < ${now}`
      ))
      .returning();
    return result.length;
  }

  // =========================
  // À LA CARTE SERVICES
  // =========================

  async getAlaCarteServices(): Promise<AlaCarteService[]> {
    return db.select()
      .from(alaCarteServices)
      .where(eq(alaCarteServices.isActive, true));
  }

  async getAlaCarteService(id: string): Promise<AlaCarteService | undefined> {
    const [service] = await db.select()
      .from(alaCarteServices)
      .where(eq(alaCarteServices.id, id));
    return service;
  }

  async getAlaCarteServicePricing(
    serviceId: string, 
    vendorId: string
  ): Promise<{ 
    service: AlaCarteService; 
    tier: SubscriptionTier | null; 
    basePriceCents: number; 
    discountPercent: number; 
    finalPriceCents: number 
  } | null> {
    const service = await this.getAlaCarteService(serviceId);
    if (!service) {
      return null;
    }

    const subscription = await this.getVendorSubscription(vendorId);
    let tier: SubscriptionTier | null = null;
    let discountPercent = 0;

    if (subscription) {
      const [tierRow] = await db.select()
        .from(subscriptionTiers)
        .where(eq(subscriptionTiers.id, subscription.tierId));
      if (tierRow) {
        tier = tierRow;
        discountPercent = tierRow.alaCarteDiscountPercent;
      }
    }

    const basePriceCents = service.basePriceInCents;
    const finalPriceCents = Math.round(basePriceCents * (100 - discountPercent) / 100);

    return {
      service,
      tier,
      basePriceCents,
      discountPercent,
      finalPriceCents,
    };
  }

  async createAlaCartePurchase(data: {
    vendorId: string;
    businessId: string;
    serviceId: string;
    tierIdAtPurchase: string | null;
    basePriceInCents: number;
    discountPercent: number;
    finalPriceInCents: number;
    platformFeeInCents: number;
    stripeCheckoutSessionId?: string;
  }): Promise<AlaCartePurchase> {
    const [purchase] = await db.insert(alaCartePurchases).values({
      vendorId: data.vendorId,
      businessId: data.businessId,
      serviceId: data.serviceId,
      tierIdAtPurchase: data.tierIdAtPurchase,
      basePriceInCents: data.basePriceInCents,
      discountPercent: data.discountPercent,
      finalPriceInCents: data.finalPriceInCents,
      platformFeeInCents: data.platformFeeInCents,
      stripeCheckoutSessionId: data.stripeCheckoutSessionId,
      paymentStatus: 'pending',
    }).returning();
    return purchase;
  }

  async getAlaCartePurchase(id: string): Promise<AlaCartePurchase | undefined> {
    const [purchase] = await db.select()
      .from(alaCartePurchases)
      .where(eq(alaCartePurchases.id, id));
    return purchase;
  }

  async getAlaCartePurchaseByCheckoutSession(sessionId: string): Promise<AlaCartePurchase | undefined> {
    const [purchase] = await db.select()
      .from(alaCartePurchases)
      .where(eq(alaCartePurchases.stripeCheckoutSessionId, sessionId));
    return purchase;
  }

  async updateAlaCartePurchase(id: string, updates: Partial<AlaCartePurchase>): Promise<AlaCartePurchase | undefined> {
    const [purchase] = await db.update(alaCartePurchases)
      .set(updates)
      .where(eq(alaCartePurchases.id, id))
      .returning();
    return purchase;
  }

  async getVendorAlaCartePurchases(vendorId: string): Promise<AlaCartePurchase[]> {
    return db.select()
      .from(alaCartePurchases)
      .where(eq(alaCartePurchases.vendorId, vendorId));
  }

  // =========================
  // FULFILLMENT TASKS (Admin)
  // =========================

  async getAllFulfillmentTasks(filters?: {
    status?: string;
    taskType?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: FulfillmentTask[]; total: number }> {
    const conditions: any[] = [];
    
    if (filters?.status) {
      conditions.push(eq(fulfillmentTasks.status, filters.status));
    }
    if (filters?.taskType) {
      conditions.push(eq(fulfillmentTasks.taskType, filters.taskType));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(fulfillmentTasks)
      .where(whereClause);
    
    const tasks = await db.select()
      .from(fulfillmentTasks)
      .where(whereClause)
      .orderBy(desc(fulfillmentTasks.isPriority), desc(fulfillmentTasks.createdAt))
      .limit(filters?.limit || 50)
      .offset(filters?.offset || 0);

    return { tasks, total: countResult?.count || 0 };
  }

  async getFulfillmentTask(id: string): Promise<FulfillmentTask | undefined> {
    const [task] = await db.select()
      .from(fulfillmentTasks)
      .where(eq(fulfillmentTasks.id, id));
    return task;
  }

  async getFulfillmentTaskWithDetails(id: string): Promise<{
    task: FulfillmentTask;
    vendor: User | undefined;
    business: Business | undefined;
    purchase?: AlaCartePurchase;
    allowance?: BenefitAllowance;
  } | undefined> {
    const task = await this.getFulfillmentTask(id);
    if (!task) return undefined;

    const vendor = await this.getUser(task.vendorId);
    const business = task.businessId ? await this.getBusiness(task.businessId) : undefined;

    let purchase: AlaCartePurchase | undefined;
    let allowance: BenefitAllowance | undefined;

    if (task.sourceType === 'ala_carte' && task.sourceId) {
      purchase = await this.getAlaCartePurchase(task.sourceId);
    } else if (task.sourceType === 'benefit' && task.sourceId) {
      const [found] = await db.select()
        .from(benefitAllowances)
        .where(eq(benefitAllowances.id, task.sourceId));
      allowance = found;
    }

    return { task, vendor, business, purchase, allowance };
  }

  async updateFulfillmentTask(id: string, updates: Partial<FulfillmentTask>): Promise<FulfillmentTask | undefined> {
    const [task] = await db.update(fulfillmentTasks)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(fulfillmentTasks.id, id))
      .returning();
    return task;
  }

  async getVendorFulfillmentTasks(vendorId: string): Promise<FulfillmentTask[]> {
    return db.select()
      .from(fulfillmentTasks)
      .where(eq(fulfillmentTasks.vendorId, vendorId))
      .orderBy(desc(fulfillmentTasks.createdAt));
  }

  // =========================
  // VENDOR PRODUCTS
  // =========================

  async getVendorProducts(businessId: string): Promise<VendorProduct[]> {
    return db.select()
      .from(vendorProducts)
      .where(eq(vendorProducts.businessId, businessId));
  }

  async getVendorProduct(id: string): Promise<VendorProduct | undefined> {
    const [product] = await db.select()
      .from(vendorProducts)
      .where(eq(vendorProducts.id, id));
    return product;
  }

  async createVendorProduct(data: InsertVendorProduct): Promise<VendorProduct> {
    const id = randomUUID();
    const [product] = await db.insert(vendorProducts)
      .values({ id, ...data })
      .returning();
    return product;
  }

  async updateVendorProduct(id: string, updates: Partial<VendorProduct>): Promise<VendorProduct | undefined> {
    const [product] = await db.update(vendorProducts)
      .set(updates)
      .where(eq(vendorProducts.id, id))
      .returning();
    return product;
  }

  async deleteVendorProduct(id: string): Promise<void> {
    await db.delete(vendorProducts).where(eq(vendorProducts.id, id));
  }

  // =========================
  // VENDOR SERVICES
  // =========================

  async getVendorServicesByBusiness(businessId: string): Promise<VendorService[]> {
    return db.select()
      .from(vendorServices)
      .where(eq(vendorServices.businessId, businessId));
  }

  async getVendorService(id: string): Promise<VendorService | undefined> {
    const [service] = await db.select()
      .from(vendorServices)
      .where(eq(vendorServices.id, id));
    return service;
  }

  async createVendorService(data: InsertVendorService): Promise<VendorService> {
    const id = randomUUID();
    const [service] = await db.insert(vendorServices)
      .values({ id, ...data })
      .returning();
    return service;
  }

  async updateVendorService(id: string, updates: Partial<VendorService>): Promise<VendorService | undefined> {
    const [service] = await db.update(vendorServices)
      .set(updates)
      .where(eq(vendorServices.id, id))
      .returning();
    return service;
  }

  async deleteVendorService(id: string): Promise<void> {
    await db.delete(vendorServices).where(eq(vendorServices.id, id));
  }

  // =========================
  // REFUND REQUESTS
  // =========================

  async createRefundRequest(data: InsertRefundRequest): Promise<RefundRequest> {
    const id = randomUUID();
    const [request] = await db.insert(refundRequests)
      .values({
        id,
        requesterId: data.requesterId,
        requesterType: data.requesterType,
        targetType: data.targetType,
        targetId: data.targetId,
        reason: data.reason,
        amount: data.amount,
        status: data.status || 'pending',
        adminNotifiedAt: new Date(),
      })
      .returning();
    return request;
  }

  async getRefundRequest(id: string): Promise<RefundRequest | undefined> {
    const [request] = await db.select()
      .from(refundRequests)
      .where(eq(refundRequests.id, id));
    return request;
  }

  async getRefundRequestsByRequester(requesterId: string): Promise<RefundRequest[]> {
    return db.select()
      .from(refundRequests)
      .where(eq(refundRequests.requesterId, requesterId));
  }

  async getRefundRequestsByTarget(targetType: string, targetId: string): Promise<RefundRequest[]> {
    return db.select()
      .from(refundRequests)
      .where(and(
        eq(refundRequests.targetType, targetType),
        eq(refundRequests.targetId, targetId)
      ));
  }

  async getAllPendingRefundRequests(): Promise<(RefundRequest & { requesterName: string | null; requesterEmail: string | null })[]> {
    const results = await db.select({
      id: refundRequests.id,
      requesterId: refundRequests.requesterId,
      requesterType: refundRequests.requesterType,
      targetType: refundRequests.targetType,
      targetId: refundRequests.targetId,
      reason: refundRequests.reason,
      amount: refundRequests.amount,
      status: refundRequests.status,
      adminNotes: refundRequests.adminNotes,
      adminNotifiedAt: refundRequests.adminNotifiedAt,
      resolvedAt: refundRequests.resolvedAt,
      resolvedBy: refundRequests.resolvedBy,
      createdAt: refundRequests.createdAt,
      updatedAt: refundRequests.updatedAt,
      requesterName: users.name,
      requesterEmail: users.email,
    })
      .from(refundRequests)
      .leftJoin(users, eq(refundRequests.requesterId, users.id))
      .where(eq(refundRequests.status, 'pending'));
    return results;
  }

  async updateRefundRequest(id: string, updates: Partial<RefundRequest>): Promise<RefundRequest | undefined> {
    const [request] = await db.update(refundRequests)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(refundRequests.id, id))
      .returning();
    return request;
  }

  // =========================
  // AVAILABILITY SLOTS
  // =========================

  async getAvailabilitySlots(providerType: string, providerId: string): Promise<AvailabilitySlot[]> {
    return db.select()
      .from(availabilitySlots)
      .where(and(
        eq(availabilitySlots.providerType, providerType),
        eq(availabilitySlots.providerId, providerId)
      ));
  }

  async createAvailabilitySlot(data: InsertAvailabilitySlot): Promise<AvailabilitySlot> {
    const id = randomUUID();
    const [slot] = await db.insert(availabilitySlots)
      .values({
        id,
        providerType: data.providerType,
        providerId: data.providerId,
        dayOfWeek: data.dayOfWeek,
        startTime: data.startTime,
        endTime: data.endTime,
        isRecurring: data.isRecurring ?? true,
        specificDate: data.specificDate || null,
        isAvailable: data.isAvailable ?? true,
      })
      .returning();
    return slot;
  }

  async updateAvailabilitySlot(id: string, updates: Partial<AvailabilitySlot>): Promise<AvailabilitySlot | undefined> {
    const [slot] = await db.update(availabilitySlots)
      .set(updates)
      .where(eq(availabilitySlots.id, id))
      .returning();
    return slot;
  }

  async deleteAvailabilitySlot(id: string): Promise<void> {
    await db.delete(availabilitySlots).where(eq(availabilitySlots.id, id));
  }

  // =========================
  // SCHEDULING (Unconfirmed Bookings)
  // =========================

  async createScheduling(data: InsertScheduling): Promise<Scheduling> {
    const id = randomUUID();
    const [sched] = await db.insert(scheduling)
      .values({
        id,
        providerType: data.providerType,
        providerId: data.providerId,
        clientId: data.clientId,
        serviceId: data.serviceId || null,
        serviceName: data.serviceName || null,
        servicePrice: data.servicePrice || null,
        scheduledDate: data.scheduledDate,
        scheduledTime: data.scheduledTime,
        durationMinutes: data.durationMinutes,
        notes: data.notes || null,
        status: data.status || 'pending',
      })
      .returning();
    return sched;
  }

  async getScheduling(id: string): Promise<Scheduling | undefined> {
    const [sched] = await db.select()
      .from(scheduling)
      .where(eq(scheduling.id, id));
    return sched;
  }

  async getSchedulingByProvider(providerType: string, providerId: string): Promise<Scheduling[]> {
    return db.select()
      .from(scheduling)
      .where(and(
        eq(scheduling.providerType, providerType),
        eq(scheduling.providerId, providerId)
      ));
  }

  async getSchedulingByClient(clientId: string): Promise<Scheduling[]> {
    return db.select()
      .from(scheduling)
      .where(eq(scheduling.clientId, clientId));
  }

  async updateScheduling(id: string, updates: Partial<Scheduling>): Promise<Scheduling | undefined> {
    const [sched] = await db.update(scheduling)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(scheduling.id, id))
      .returning();
    return sched;
  }

  // =========================
  // FEED POSTS
  // =========================

  async createFeedPost(data: InsertFeedPost): Promise<FeedPost> {
    const id = randomUUID();
    const [post] = await db.insert(feedPosts)
      .values({
        id,
        authorId: data.authorId,
        authorType: data.authorType,
        postType: data.postType || 'text',
        content: data.content,
        imageUrl: data.imageUrl || null,
        taggedBusinessId: data.taggedBusinessId || null,
        taggedPhotographerId: data.taggedPhotographerId || null,
        productId: data.productId || null,
        serviceId: data.serviceId || null,
      })
      .returning();
    return post;
  }

  async getFeedPost(id: string): Promise<FeedPost | undefined> {
    const [post] = await db.select()
      .from(feedPosts)
      .where(eq(feedPosts.id, id));
    return post;
  }

  async getFeedPosts(limit = 50, offset = 0): Promise<FeedPost[]> {
    return db.select()
      .from(feedPosts)
      .where(eq(feedPosts.isActive, true))
      .orderBy(sql`${feedPosts.createdAt} DESC`)
      .limit(limit)
      .offset(offset);
  }

  async getUserFeedPosts(authorId: string): Promise<FeedPost[]> {
    return db.select()
      .from(feedPosts)
      .where(and(
        eq(feedPosts.authorId, authorId),
        eq(feedPosts.isActive, true)
      ))
      .orderBy(sql`${feedPosts.createdAt} DESC`);
  }

  async getBusinessFeedPosts(businessId: string): Promise<FeedPost[]> {
    return db.select()
      .from(feedPosts)
      .where(and(
        eq(feedPosts.taggedBusinessId, businessId),
        eq(feedPosts.isActive, true)
      ))
      .orderBy(sql`${feedPosts.createdAt} DESC`);
  }

  async getPhotographerFeedPosts(photographerId: string): Promise<FeedPost[]> {
    return db.select()
      .from(feedPosts)
      .where(and(
        eq(feedPosts.taggedPhotographerId, photographerId),
        eq(feedPosts.isActive, true)
      ))
      .orderBy(sql`${feedPosts.createdAt} DESC`);
  }

  async deleteFeedPost(id: string): Promise<void> {
    await db.update(feedPosts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(feedPosts.id, id));
  }

  async likePost(postId: string, userId: string): Promise<boolean> {
    const existing = await db.select()
      .from(postLikes)
      .where(and(
        eq(postLikes.postId, postId),
        eq(postLikes.userId, userId)
      ));
    
    if (existing.length > 0) return false;

    await db.insert(postLikes)
      .values({
        id: randomUUID(),
        postId,
        userId,
      });
    
    await db.update(feedPosts)
      .set({ likesCount: sql`${feedPosts.likesCount} + 1` })
      .where(eq(feedPosts.id, postId));
    
    return true;
  }

  async unlikePost(postId: string, userId: string): Promise<boolean> {
    const [deleted] = await db.delete(postLikes)
      .where(and(
        eq(postLikes.postId, postId),
        eq(postLikes.userId, userId)
      ))
      .returning();
    
    if (!deleted) return false;

    await db.update(feedPosts)
      .set({ likesCount: sql`GREATEST(${feedPosts.likesCount} - 1, 0)` })
      .where(eq(feedPosts.id, postId));
    
    return true;
  }

  async hasUserLikedPost(postId: string, userId: string): Promise<boolean> {
    const [like] = await db.select()
      .from(postLikes)
      .where(and(
        eq(postLikes.postId, postId),
        eq(postLikes.userId, userId)
      ));
    return !!like;
  }

  async addPostComment(data: InsertPostComment): Promise<PostComment> {
    const id = randomUUID();
    const [comment] = await db.insert(postComments)
      .values({
        id,
        postId: data.postId,
        userId: data.userId,
        content: data.content,
      })
      .returning();
    
    await db.update(feedPosts)
      .set({ commentsCount: sql`${feedPosts.commentsCount} + 1` })
      .where(eq(feedPosts.id, data.postId));
    
    return comment;
  }

  async getPostComments(postId: string): Promise<PostComment[]> {
    return db.select()
      .from(postComments)
      .where(eq(postComments.postId, postId))
      .orderBy(sql`${postComments.createdAt} ASC`);
  }

  async canCustomerTagBusiness(customerId: string, businessId: string): Promise<boolean> {
    // Check if customer has an order or appointment with this business
    const [orderExists] = await db.select({ id: orders.id })
      .from(orders)
      .where(and(
        eq(orders.customerId, customerId),
        eq(orders.businessId, businessId),
        eq(orders.status, 'completed')
      ))
      .limit(1);
    
    if (orderExists) return true;

    const [appointmentExists] = await db.select({ id: appointments.id })
      .from(appointments)
      .where(and(
        eq(appointments.customerId, customerId),
        eq(appointments.businessId, businessId),
        eq(appointments.status, 'completed')
      ))
      .limit(1);
    
    return !!appointmentExists;
  }

  async canCustomerTagPhotographer(customerId: string, photographerId: string): Promise<boolean> {
    // Check if customer has a completed shoot booking with this photographer
    const [bookingExists] = await db.select({ id: shootBookings.id })
      .from(shootBookings)
      .where(and(
        eq(shootBookings.clientId, customerId),
        eq(shootBookings.photographerId, photographerId),
        eq(shootBookings.status, 'completed')
      ))
      .limit(1);
    
    return !!bookingExists;
  }

  // =========================
  // PROFILE COMMENTS
  // =========================

  async createProfileComment(data: InsertProfileComment): Promise<ProfileComment> {
    const id = randomUUID();
    const [comment] = await db.insert(profileComments)
      .values({
        id,
        targetType: data.targetType,
        targetId: data.targetId,
        userId: data.userId,
        content: data.content
      })
      .returning();
    return comment;
  }

  async getProfileComments(targetType: string, targetId: string): Promise<(ProfileComment & { authorName: string | null; authorImage: string | null })[]> {
    const result = await db.select({
      id: profileComments.id,
      targetType: profileComments.targetType,
      targetId: profileComments.targetId,
      userId: profileComments.userId,
      content: profileComments.content,
      createdAt: profileComments.createdAt,
      authorName: users.name,
      authorImage: users.profileImageUrl
    })
    .from(profileComments)
    .leftJoin(users, eq(profileComments.userId, users.id))
    .where(and(
      eq(profileComments.targetType, targetType),
      eq(profileComments.targetId, targetId)
    ))
    .orderBy(sql`${profileComments.createdAt} DESC`);
    
    return result;
  }

  // =========================
  // UNIFIED SEARCH
  // =========================

  async searchAll(filters?: { city?: string; category?: string; search?: string }): Promise<{
    businesses: Business[];
    photographers: Photographer[];
  }> {
    // Search businesses
    const businessResults = await this.getBusinesses(filters);

    // Search photographers with similar filters
    let photographerResults = await db.select().from(photographers);
    
    if (filters?.city) {
      photographerResults = photographerResults.filter(p => 
        p.city?.toLowerCase().includes(filters.city!.toLowerCase())
      );
    }
    
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      photographerResults = photographerResults.filter(p => 
        p.displayName?.toLowerCase().includes(searchLower) ||
        p.bio?.toLowerCase().includes(searchLower) ||
        p.specialties?.some(s => s.toLowerCase().includes(searchLower))
      );
    }

    return {
      businesses: businessResults,
      photographers: photographerResults
    };
  }
}

export const storage = new DatabaseStorage();
