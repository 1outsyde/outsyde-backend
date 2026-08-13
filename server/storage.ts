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
  type InsertAppointment,
  type Order,
  type InsertOrder,
  type OrderGroup,
  type InsertOrderGroup,
  type Conversation,
  type InsertConversation,
  type Message,
  type InsertMessage,
  type PointTransaction,
  type PushSubscription,
  type InsertPushSubscription,
  type Notification,
  type InsertNotification,
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
  type BusinessAvailability,
  type InsertBusinessAvailability,
  type PhotographerAvailability,
  type InsertPhotographerAvailability,
  type StaffMember,
  type InsertStaffMember,
  type UpdateStaffMember,
  type StaffAvailability,
  type InsertStaffAvailability,
  type StaffInvite,
  type InsertStaffInvite,
  type StaffService,
  type InsertStaffService,
  type Shipment,
  type InsertShipment,
  type AuditLog,
  type InsertAuditLog,
  type Referral,
  type UserBlock,
  type InsertUserBlock,
  type MessageReport,
  type InsertMessageReport,
  type InfluencerProfile,
  type InsertInfluencerProfile,
  type InfluencerApplication,
  type InsertInfluencerApplication,
  type InfluencerCampaign,
  type InsertInfluencerCampaign,
  type InfluencerCampaignAssignment,
  type InsertInfluencerCampaignAssignment,
  type InfluencerReferralEvent,
  type InsertInfluencerReferralEvent,
  type InfluencerEarningLedger,
  type InsertInfluencerEarningLedger,
  type InfluencerPayout,
  type InsertInfluencerPayout,
  type SearchIndexEntry,
  type InsertSearchIndexEntry,
  type Follow,
  type InsertFollow,
  type HoursOfOperation,
  type WeeklyAvailability,
  type InsertWeeklyAvailability,
  type ProviderBlock,
  type InsertProviderBlock,
  type ConsumerAddress,
  type InsertConsumerAddress,
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
  orderGroups,
  conversations,
  messages,
  pointTransactions,
  referrals,
  pushSubscriptions,
  notifications,
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
  userSavedPosts,
  postComments,
  profileComments,
  businessAvailability,
  photographerAvailability,
  staffMembers,
  staffAvailability,
  staffInvites,
  staffServices,
  shipments,
  auditLogs,
  userBlocks,
  messageReports,
  influencerProfiles,
  influencerApplications,
  influencerCampaigns,
  influencerCampaignAssignments,
  influencerReferralEvents,
  influencerEarningLedger,
  influencerPayouts,
  searchIndex,
  follows,
  userInterests,
  oauthStates,
  weeklyAvailability,
  providerBlocks,
  consumerAddresses,
  pendingPointTransactions,
  type PendingPointTransaction,
  isValidOrderTransition,
  isValidBookingTransition
} from "@shared/schema";
import { db } from "./db";
import { eq, ilike, or, and, sql, isNull, isNotNull, desc, asc, gte, lte, ne, inArray, notInArray } from "drizzle-orm";
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
  // Expanded profile fields (all optional)
  shootLocation?: string[];
  studioName?: string | null;
  studioAddress?: string | null;
  usesSharedStudio?: boolean;
  travelRadius?: string | null;
  pricingType?: string | null;
  startingPrice?: number | null;
  minimumBooking?: string | null;
  additionalServices?: string[];
  experienceLevel?: string | null;
  equipmentLevel?: string | null;
  deliveryTime?: string | null;
};

export type StaffInvitePreview = {
  businessName: string | null;
  businessLogo: string | null;
  businessCategory: string | null;
  businessCity: string | null;
  businessState: string | null;
  role: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  status: string;
  isExpired: boolean;
};

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByGoogleSub(googleSub: string): Promise<User | undefined>;
  getUserByAppleId(appleId: string): Promise<User | undefined>;
  getAdminUsers(): Promise<User[]>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  getBusiness(id: string): Promise<Business | undefined>;
  getBusinessByOwnerId(ownerId: string): Promise<Business | undefined>;
  getBusinessByStripeAccountId(stripeAccountId: string): Promise<Business | undefined>;
  getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]>;
  getBusinessesByApprovalStatus(status: string): Promise<(Business & { owner?: User })[]>;
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

  // OAuth State CRUD (for mobile OAuth CSRF protection)
  createOAuthState(state: string, expiresAt: Date, deviceId?: string): Promise<void>;
  validateAndConsumeOAuthState(state: string): Promise<{ state: string; deviceId: string | null } | null>;
  cleanupExpiredOAuthStates(): Promise<void>;

  // Photographer CRUD
  createPhotographer(data: NewPhotographerInput): Promise<Photographer>;
  getPhotographer(id: string): Promise<Photographer | undefined>;
  getPhotographerByUserId(userId: string): Promise<Photographer | undefined>;
  getPhotographerByStripeAccountId(stripeAccountId: string): Promise<Photographer | undefined>;
  listPhotographers(): Promise<Photographer[]>;
  listAllPhotographers(): Promise<Photographer[]>;
  updatePhotographer(id: string, updates: Partial<Photographer>): Promise<Photographer | undefined>;
  deletePhotographer(id: string): Promise<void>;

  // Photographer Services CRUD
  createPhotographerService(data: InsertPhotographerService): Promise<PhotographerService>;
  getPhotographerService(id: string): Promise<PhotographerService | undefined>;
  getPhotographerServices(photographerId: string): Promise<PhotographerService[]>; // Public: only live services
  getAllPhotographerServices(photographerId: string): Promise<PhotographerService[]>; // Owner dashboard: all statuses
  updatePhotographerService(id: string, updates: Partial<PhotographerService>): Promise<PhotographerService | undefined>;
  deletePhotographerService(id: string): Promise<void>;

  // Reviews (verified purchases only)
  createReview(data: InsertReview): Promise<Review>;
  getReviewsByTarget(targetType: string, targetId: string): Promise<Review[]>;
  getReviewByBooking(bookingType: string, bookingId: string): Promise<Review | undefined>;
  hasReviewedBooking(bookingType: string, bookingId: string): Promise<boolean>;
  verifyCustomerCanReview(customerId: string, targetType: string, targetId: string, bookingType: string, bookingId: string): Promise<{ canReview: boolean; reason?: string }>;
  getReviewableBookings(customerId: string): Promise<{ shootBookings: ShootBooking[]; appointments: Appointment[]; orders: Order[] }>;

  // Appointments
  createAppointment(data: InsertAppointment): Promise<Appointment>;
  getAppointment(id: string): Promise<Appointment | undefined>;
  getAppointmentsByBusiness(businessId: string): Promise<Appointment[]>;
  getAppointmentsByBusinessWithDetails(businessId: string): Promise<{
    id: string;
    customerName: string;
    customerAvatar: string | null;
    date: string;
    time: string;
    serviceName: string | null;
    status: string;
    amount: number;
    subtotalAmount: number;
    bookingFeeAmount: number;
    vendorNetAmount: number;
    staffMemberId: string | null;
  }[]>;
  getAppointmentsByClient(clientId: string): Promise<Appointment[]>;
  getAppointmentsByClientWithDetails(clientId: string): Promise<{
    id: string;
    appointmentDate: string;
    appointmentTime: string;
    appointmentEndTime: string | null;
    totalPrice: number;
    status: string;
    businessId: string;
    serviceId: string;
    staffMemberId: string | null;
    businessName: string | null;
    businessLogoImage: string | null;
    businessCity: string | null;
    businessState: string | null;
    businessAddress: string | null;
    serviceName: string | null;
    serviceDurationMinutes: number | null;
    staffDisplayName: string | null;
    staffProfileImageUrl: string | null;
    serviceLocationType: string | null;
    alternateAddress: string | null;
    alternateCity: string | null;
    alternateState: string | null;
    alternateZipCode: string | null;
    virtualLink: string | null;
    fullRefundWindow: string | null;
    hasPartialRefund: boolean | null;
    partialRefundWindow: string | null;
    partialRefundPercentage: number | null;
    hasCancellationFee: boolean | null;
    cancellationFeeType: string | null;
    cancellationFeeAmount: number | null;
    customerServiceAddress: string | null;
    customerServiceCity: string | null;
    customerServiceState: string | null;
    customerServiceZipCode: string | null;
  }[]>;
  getAppointmentsByStaffMember(staffMemberId: string): Promise<Appointment[]>;
  updateAppointment(id: string, updates: Partial<Appointment>): Promise<Appointment | undefined>;
  updateAppointmentWithValidation(appointmentId: string, updates: Partial<Appointment>, actorId?: string): Promise<{ success: boolean; appointment?: Appointment; error?: string }>;
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
    draftExpiresAt?: Date | null;
  }): Promise<ShootBooking>;

  // Chat (Real-time messaging)
  getOrCreateConversation(participant1Id: string, participant2Id: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;
  getUserConversations(userId: string): Promise<(Conversation & { otherParticipant: User })[]>;
  createMessage(data: { conversationId: string; senderId: string; content: string }): Promise<Message>;
  getConversationMessages(conversationId: string, limit?: number, before?: string): Promise<Message[]>;
  markMessagesAsRead(conversationId: string, userId: string): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;
  getUnreadCountPerConversation(userId: string): Promise<Map<string, number>>;

  // Outsyde Points (Loyalty System)
  // Formula: points_earned = base_charge * 4  (where base_charge is pre-upcharge amount in dollars)
  // Equivalently: points_earned = round(consumer_total_cents * 4 / 108)
  // Redemption: 100 points = $1
  getUserPointsBalance(userId: string): Promise<number>;
  earnPoints(data: {
    userId: string;
    dollarAmountCents: number;
    transactionType: 'photographer_booking' | 'business_transaction' | 'bonus';
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<PointTransaction>;
  getPendingPointTransactions(opts?: { userId?: string; status?: string; limit?: number }): Promise<PendingPointTransaction[]>;
  approvePendingPointTransaction(pendingId: string, reviewerId: string, note?: string): Promise<{ pending: PendingPointTransaction; live: PointTransaction }>;
  rejectPendingPointTransaction(pendingId: string, reviewerId: string, note?: string): Promise<PendingPointTransaction>;
  redeemPoints(data: {
    userId: string;
    points: number;
    orderTotalCents?: number;
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
    isFirstBooking?: boolean;
    isDeposit?: boolean;
    isSubscription?: boolean;
  }): Promise<{ transaction: PointTransaction; discountCents: number } | { error: string }>;
  reversePoints(data: {
    userId: string;
    originalTransactionId: string;
    reason: string;
  }): Promise<PointTransaction | { error: string }>;
  getPointTransactions(userId: string, limit?: number): Promise<PointTransaction[]>;
  getAvailableRedemptionTiers(balance: number): { points: number; valueCents: number }[];
  calculatePointsValue(points: number): number; // Returns discount in cents

  // Referral system (deferred rewards - only after first transaction)
  generateReferralCode(userId: string): Promise<string>;
  getUserReferralCode(userId: string): Promise<string | null>;
  getUserByReferralCode(code: string): Promise<User | undefined>;
  processReferral(newUserId: string, referralCode: string): Promise<{ success: boolean; referrerId?: string; error?: string }>;
  getPendingReferral(referredUserId: string): Promise<Referral | undefined>;
  completeReferral(referredUserId: string, transactionId: string, transactionType: string): Promise<{ success: boolean; error?: string }>;
  getReferralStats(userId: string): Promise<{ totalReferrals: number; completedReferrals: number; pendingReferrals: number; totalPointsEarned: number }>;
  getSuccessfulReferralCount(referrerId: string): Promise<number>;

  // Push Subscriptions (Browser Push Notifications)
  savePushSubscription(data: InsertPushSubscription): Promise<PushSubscription>;
  getPushSubscription(userId: string, endpoint: string): Promise<PushSubscription | undefined>;
  getUserPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  deletePushSubscription(userId: string, endpoint: string): Promise<void>;
  getAllPushSubscriptions(): Promise<PushSubscription[]>;

  // Notifications (In-app notifications)
  createNotification(data: InsertNotification): Promise<Notification>;
  getUserNotifications(userId: string, options?: { limit?: number; unreadOnly?: boolean }): Promise<Notification[]>;
  markNotificationRead(id: string, userId: string): Promise<Notification | undefined>;
  markAllNotificationsRead(userId: string): Promise<void>;
  getUnreadNotificationCount(userId: string): Promise<number>;

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
  getVendorSubscriptionByBusinessId(businessId: string): Promise<VendorSubscription | undefined>;
  updateVendorSubscription(id: string, updates: Partial<VendorSubscription>): Promise<VendorSubscription | undefined>;
  isBusinessSubscriptionActive(businessId: string, gracePeriodDays?: number): Promise<{ active: boolean; status?: string; reason?: string }>;
  isVendorSubscriptionActive(vendorId: string, gracePeriodDays?: number): Promise<{ active: boolean; status?: string; reason?: string }>;
  getTierBenefits(tierId: string): Promise<TierBenefit[]>;
  createBenefitAllowances(subscriptionId: string, overrideCycleDates?: { periodStart: Date; periodEnd: Date; quarterStart: Date; quarterEnd: Date }): Promise<BenefitAllowance[]>;
  renewBenefitAllowancesForNewCycle(): Promise<number>;
  getVendorBenefitAllowances(vendorId: string): Promise<(BenefitAllowance & { benefit: TierBenefit })[]>;
  useBenefit(allowanceId: string, vendorId: string, businessId: string, notes?: string): Promise<{ success: boolean; allowance?: BenefitAllowance; task?: FulfillmentTask; error?: string }>;
  expireOldAllowances(): Promise<number>;
  migrateBenefitsForTierChange(subscriptionId: string, previousTierId: string, newTierId: string): Promise<void>;

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
  getServices(): Promise<VendorService[]>;
  createVendorService(data: InsertVendorService): Promise<VendorService>;
  updateVendorService(id: string, updates: Partial<VendorService>): Promise<VendorService | undefined>;
  deleteVendorService(id: string): Promise<void>;
  updateAllVendorServicesCancellationPolicy(businessId: string, excludeServiceId: string, policy: {
    fullRefundWindow: string | null;
    hasPartialRefund: boolean;
    partialRefundWindow: string | null;
    partialRefundPercentage: number | null;
    hasCancellationFee: boolean;
    cancellationFeeType: string | null;
    cancellationFeeAmount: number | null;
  }): Promise<number>;

  // Subscription enforcement - pause/unpause items
  pauseBusinessLiveItems(businessId: string): Promise<{ pausedProducts: number; pausedServices: number }>;
  unpauseBusinessPausedItems(businessId: string): Promise<{ unpausedProducts: number; unpausedServices: number }>;

  // Business Availability Calendar
  getBusinessAvailability(businessId: string, startDate?: string, endDate?: string): Promise<BusinessAvailability[]>;
  getBusinessAvailabilitySlot(id: string): Promise<BusinessAvailability | undefined>;
  createBusinessAvailability(data: InsertBusinessAvailability): Promise<BusinessAvailability>;
  updateBusinessAvailability(id: string, updates: Partial<BusinessAvailability>): Promise<BusinessAvailability | undefined>;
  deleteBusinessAvailability(id: string): Promise<void>;
  checkBusinessSlotAvailable(businessId: string, date: string, startTime: string, endTime: string, excludeSlotId?: string): Promise<boolean>;
  reserveBusinessSlot(businessId: string, date: string, startTime: string, endTime: string, appointmentId: string): Promise<BusinessAvailability>;
  releaseBusinessSlot(appointmentId: string): Promise<boolean>;

  // Photographer Availability
  getPhotographerAvailability(photographerId: string, startDate?: string, endDate?: string): Promise<PhotographerAvailability[]>;
  getPhotographerAvailabilitySlot(id: string): Promise<PhotographerAvailability | undefined>;
  createPhotographerAvailability(data: InsertPhotographerAvailability): Promise<PhotographerAvailability>;
  updatePhotographerAvailability(id: string, updates: Partial<PhotographerAvailability>): Promise<PhotographerAvailability | undefined>;
  deletePhotographerAvailability(id: string): Promise<void>;
  checkPhotographerSlotAvailable(photographerId: string, date: string, startTime: string, endTime: string, excludeSlotId?: string): Promise<boolean>;
  reservePhotographerSlot(photographerId: string, date: string, startTime: string, endTime: string, shootBookingId: string): Promise<PhotographerAvailability>;
  releasePhotographerSlot(shootBookingId: string): Promise<boolean>;

  // Staff Members
  createStaffMember(data: InsertStaffMember): Promise<StaffMember>;
  getStaffMember(id: string): Promise<(StaffMember & { username: string | null }) | undefined>;
  getStaffMemberByUserId(userId: string): Promise<StaffMember | undefined>;
  getStaffMembersByUserId(userId: string): Promise<StaffMember[]>;
  getStaffMemberByUserIdAndBusiness(userId: string, businessId: string): Promise<StaffMember | undefined>;
  // Finds any existing staff_members row (any status) for this business matching
  // either the user id or the email — used to reactivate on re-invite instead of
  // inserting a duplicate row (G7).
  findStaffMemberForReactivation(businessId: string, userId: string | undefined | null, email: string | undefined | null): Promise<StaffMember | undefined>;
  touchStaffMemberLastActive(staffId: string): Promise<void>;
  getStaffMemberByStripeAccountId(stripeAccountId: string): Promise<StaffMember | undefined>;
  getStaffMembersByBusiness(businessId: string): Promise<(StaffMember & { username: string | null })[]>;
  getActiveStaffCount(businessId: string): Promise<number>;
  updateStaffMember(id: string, updates: Partial<StaffMember>): Promise<StaffMember | undefined>;
  deleteStaffMember(id: string): Promise<void>;
  
  // Staff Availability
  getStaffAvailability(staffMemberId: string, startDate?: string, endDate?: string): Promise<StaffAvailability[]>;
  getStaffAvailabilitySlot(id: string): Promise<StaffAvailability | undefined>;
  createStaffAvailability(data: InsertStaffAvailability): Promise<StaffAvailability>;
  updateStaffAvailability(id: string, updates: Partial<StaffAvailability>): Promise<StaffAvailability | undefined>;
  deleteStaffAvailability(id: string): Promise<void>;
  releaseStaffSlot(appointmentId: string): Promise<boolean>;
  
  // Staff Invites
  createStaffInvite(data: InsertStaffInvite): Promise<StaffInvite>;
  getStaffInvite(id: string): Promise<StaffInvite | undefined>;
  getStaffInviteByCode(code: string): Promise<StaffInvite | undefined>;
  getStaffInviteWithContext(code: string): Promise<StaffInvitePreview | null>;
  getStaffInvitesByBusiness(businessId: string): Promise<StaffInvite[]>;
  getStaffInvitesByEmail(email: string): Promise<StaffInvite[]>;
  updateStaffInvite(id: string, updates: Partial<StaffInvite>): Promise<StaffInvite | undefined>;
  // Resets a dead (expired/revoked/stale-pending) invite row back to a fresh
  // pending state instead of inserting a duplicate row for the same email —
  // used by the resend path in POST /api/vendor/staff/invites.
  reactivateStaffInvite(id: string, data: { phone?: string | null; role?: string; invitedByUserId?: string }): Promise<StaffInvite | undefined>;
  deleteStaffInvite(id: string): Promise<void>;

  // Staff Services (staff-owned bookable services)
  createStaffService(data: InsertStaffService): Promise<StaffService>;
  getStaffService(id: string): Promise<StaffService | undefined>;
  getStaffServicesByStaffMember(staffMemberId: string): Promise<StaffService[]>;
  getLiveStaffServicesByStaffMember(staffMemberId: string): Promise<StaffService[]>;
  hasLiveStaffServices(staffMemberId: string): Promise<boolean>;
  updateStaffService(id: string, updates: Partial<StaffService>): Promise<StaffService | undefined>;
  deleteStaffService(id: string): Promise<void>;

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
  getAlgorithmicFeed(userId: string | null, limit?: number, offset?: number, city?: string): Promise<FeedPost[]>;
  getUserFeedPosts(authorId: string): Promise<FeedPost[]>;
  getUserFeedPostsByIntent(authorId: string, postIntent: 'social' | 'promotion', limit?: number): Promise<FeedPost[]>;
  getBusinessFeedPosts(businessId: string): Promise<FeedPost[]>;
  getPhotographerFeedPosts(photographerId: string): Promise<FeedPost[]>;
  deleteFeedPost(id: string): Promise<void>;
  updateFeedPostContent(id: string, content: string): Promise<FeedPost | undefined>;
  likePost(postId: string, userId: string): Promise<boolean>;
  unlikePost(postId: string, userId: string): Promise<boolean>;
  savePost(postId: string, userId: string): Promise<boolean>;
  unsavePost(postId: string, userId: string): Promise<boolean>;
  getSavedPosts(userId: string): Promise<any[]>;
  hasUserLikedPost(postId: string, userId: string): Promise<boolean>;
  getLikedPostIds(userId: string, postIds: string[]): Promise<Set<string>>;
  addPostComment(data: InsertPostComment): Promise<PostComment>;
  getPostComments(postId: string): Promise<PostComment[]>;
  canCustomerTagBusiness(customerId: string, businessId: string): Promise<boolean>;
  canCustomerTagPhotographer(customerId: string, photographerId: string): Promise<boolean>;

  // Profile Comments (for businesses and photographers)
  createProfileComment(data: InsertProfileComment): Promise<ProfileComment>;
  getProfileComments(targetType: string, targetId: string): Promise<(ProfileComment & { authorName: string | null; authorUsername: string | null; authorImage: string | null })[]>;

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
  getProductImagesByIds(productIds: string[]): Promise<Record<string, string | null>>;
  getUserBookings(userId: string): Promise<ShootBooking[]>;
  getOrder(orderId: string): Promise<Order | undefined>;
  getOrderByCheckoutSession(sessionId: string): Promise<Order | undefined>;
  getVendorOrders(businessId: string): Promise<(Order & { customerName: string | null })[]>;
  createOrder(data: InsertOrder): Promise<Order>;
  updateOrder(orderId: string, updates: Partial<Order>): Promise<Order | undefined>;
  
  createOrderGroup(data: InsertOrderGroup): Promise<OrderGroup>;
  getOrderGroup(id: string): Promise<OrderGroup | undefined>;
  updateOrderGroup(id: string, updates: Partial<OrderGroup>): Promise<OrderGroup | undefined>;
  getOrderGroupOrders(orderGroupId: string): Promise<Order[]>;
  getNextPendingOrderInGroup(orderGroupId: string): Promise<Order | undefined>;
  getUserByBusinessOwnerId(businessId: string): Promise<User | undefined>;
  getShootBooking(id: string): Promise<ShootBooking | undefined>;
  updateShootBooking(id: string, updates: Partial<ShootBooking>): Promise<ShootBooking | undefined>;
  getShootBookingByCheckoutSession(sessionId: string): Promise<ShootBooking | undefined>;
  getPhotographerBookings(photographerId: string): Promise<ShootBooking[]>;
  getMessages(conversationId: string): Promise<Message[]>;

  // Shipment Tracking
  createShipment(data: InsertShipment): Promise<Shipment>;
  getShipment(id: string): Promise<Shipment | undefined>;
  getShipmentsByOrder(orderId: string): Promise<Shipment[]>;
  getShipmentsByBusiness(businessId: string): Promise<Shipment[]>;
  updateShipment(id: string, updates: Partial<Shipment>): Promise<Shipment | undefined>;

  // Audit Logging
  createAuditLog(data: InsertAuditLog): Promise<AuditLog>;
  getAuditLogs(targetType: string, targetId: string): Promise<AuditLog[]>;
  getAuditLogsFiltered(filters: {
    action?: string;
    targetType?: string;
    targetId?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditLog[]>;

  // Order State Machine (with validation)
  updateOrderWithValidation(orderId: string, updates: Partial<Order>, actorId?: string): Promise<{ success: boolean; order?: Order; error?: string }>;
  updateBookingWithValidation(bookingId: string, updates: Partial<ShootBooking>, actorId?: string): Promise<{ success: boolean; booking?: ShootBooking; error?: string }>;

  // Point Reversal on Refund
  // refundFraction: 0.0–1.0 for partial clawback; omit for full reversal.
  // Balance is floored at 0; shortfall is logged when clawback exceeds balance.
  reversePointsForRefund(userId: string, referenceType: string, referenceId: string, opts?: { refundFraction?: number; description?: string }): Promise<{ reversed: boolean; pointsReversed: number; shortfall: number }>;

  // Review Revocation on Refund
  revokeReviewsForRefund(bookingType: string, bookingId: string): Promise<number>;

  // User Blocking
  blockUser(blockerId: string, blockedId: string, reason?: string): Promise<UserBlock>;
  unblockUser(blockerId: string, blockedId: string): Promise<boolean>;
  isUserBlocked(blockerId: string, blockedId: string): Promise<boolean>;
  isUserBlockedEitherWay(userId1: string, userId2: string): Promise<boolean>;
  getBlockedUsers(userId: string): Promise<UserBlock[]>;

  // Message Reports
  createMessageReport(data: InsertMessageReport): Promise<MessageReport>;
  getMessageReports(filters?: { status?: string; reporterId?: string; reportedUserId?: string }): Promise<MessageReport[]>;
  updateMessageReport(id: string, updates: Partial<MessageReport>): Promise<MessageReport | undefined>;
  getMessageReport(id: string): Promise<MessageReport | undefined>;

  // Influencer Profiles
  createInfluencerProfile(data: InsertInfluencerProfile): Promise<InfluencerProfile>;
  getInfluencerProfile(id: string): Promise<InfluencerProfile | undefined>;
  getInfluencerProfileByUserId(userId: string): Promise<InfluencerProfile | undefined>;
  getInfluencerProfileByPromoCode(promoCode: string): Promise<InfluencerProfile | undefined>;
  updateInfluencerProfile(id: string, updates: Partial<InfluencerProfile>): Promise<InfluencerProfile | undefined>;
  listInfluencerProfiles(): Promise<InfluencerProfile[]>;

  // Influencer Applications
  createInfluencerApplication(data: InsertInfluencerApplication): Promise<InfluencerApplication>;
  getInfluencerApplication(id: string): Promise<InfluencerApplication | undefined>;
  getInfluencerApplicationByUserId(userId: string): Promise<InfluencerApplication | undefined>;
  getInfluencerApplications(status?: string): Promise<InfluencerApplication[]>;
  updateInfluencerApplication(id: string, updates: Partial<InfluencerApplication>): Promise<InfluencerApplication | undefined>;

  // Influencer Campaigns
  createInfluencerCampaign(data: InsertInfluencerCampaign): Promise<InfluencerCampaign>;
  getInfluencerCampaign(id: string): Promise<InfluencerCampaign | undefined>;
  getInfluencerCampaigns(filters?: { vendorId?: string; adminId?: string; status?: string }): Promise<InfluencerCampaign[]>;
  updateInfluencerCampaign(id: string, updates: Partial<InfluencerCampaign>): Promise<InfluencerCampaign | undefined>;

  // Influencer Campaign Assignments
  createInfluencerCampaignAssignment(data: InsertInfluencerCampaignAssignment): Promise<InfluencerCampaignAssignment>;
  getInfluencerCampaignAssignment(id: string): Promise<InfluencerCampaignAssignment | undefined>;
  getInfluencerCampaignAssignments(filters?: { campaignId?: string; influencerId?: string; status?: string }): Promise<InfluencerCampaignAssignment[]>;
  updateInfluencerCampaignAssignment(id: string, updates: Partial<InfluencerCampaignAssignment>): Promise<InfluencerCampaignAssignment | undefined>;

  // Influencer Referral Events
  createInfluencerReferralEvent(data: InsertInfluencerReferralEvent): Promise<InfluencerReferralEvent>;
  getInfluencerReferralEvents(influencerId: string): Promise<InfluencerReferralEvent[]>;
  getInfluencerReferralEventsByOrder(orderId: string): Promise<InfluencerReferralEvent[]>;
  updateInfluencerReferralEvent(id: string, updates: Partial<InfluencerReferralEvent>): Promise<InfluencerReferralEvent | undefined>;
  markInfluencerReferralEventCredited(eventId: string, ledgerEntryId: string): Promise<boolean>;

  // Influencer Earning Ledger
  createInfluencerEarningLedger(data: InsertInfluencerEarningLedger): Promise<InfluencerEarningLedger>;
  getInfluencerEarningLedger(influencerId: string, status?: string): Promise<InfluencerEarningLedger[]>;
  updateInfluencerEarningLedger(id: string, updates: Partial<InfluencerEarningLedger>): Promise<InfluencerEarningLedger | undefined>;
  getReadyForPayoutLedgerEntries(influencerId: string): Promise<InfluencerEarningLedger[]>;

  // Influencer Payouts
  createInfluencerPayout(data: InsertInfluencerPayout): Promise<InfluencerPayout>;
  getInfluencerPayout(id: string): Promise<InfluencerPayout | undefined>;
  getInfluencerPayouts(influencerId: string): Promise<InfluencerPayout[]>;
  updateInfluencerPayout(id: string, updates: Partial<InfluencerPayout>): Promise<InfluencerPayout | undefined>;

  // Unified Search Index
  upsertSearchIndexEntry(entry: InsertSearchIndexEntry): Promise<SearchIndexEntry>;
  deleteSearchIndexEntry(entityType: string, entityId: string): Promise<void>;
  rebuildSearchIndex(): Promise<void>;
  unifiedSearch(params: {
    query?: string;
    city?: string;
    category?: string;
    entityTypes?: string[];
    userLatitude?: number;
    userLongitude?: number;
    userPreferences?: {
      selectedIndustries?: string[];
      industryNiches?: Record<string, string[]>;
      industryValues?: Record<string, string[]>;
    };
    limit?: number;
    offset?: number;
    isAdmin?: boolean;
  }): Promise<{
    results: SearchIndexEntry[];
    total: number;
  }>;

  seedInitialData(): Promise<void>;

  // Follows (Private)
  createFollow(data: InsertFollow): Promise<Follow>;
  getFollow(followerUserId: string, targetUserId: string): Promise<Follow | undefined>;
  deleteFollow(followerUserId: string, targetUserId: string): Promise<void>;
  getUserFollowing(userId: string, limit?: number, offset?: number): Promise<User[]>;
  getUserFollowers(userId: string, limit?: number, offset?: number): Promise<User[]>;
  getFollowingCount(userId: string): Promise<number>;
  getFollowerCount(userId: string): Promise<number>;

  // Unified Search (normalized results)
  unifiedSearchWithScope(params: UnifiedSearchParams): Promise<UnifiedSearchResponse>;

  // Weekly Availability CRUD
  getWeeklyAvailability(providerType: string, providerId: string, staffMemberId?: string): Promise<WeeklyAvailability[]>;
  setWeeklyAvailability(providerType: string, providerId: string, slots: InsertWeeklyAvailability[], staffMemberId?: string): Promise<WeeklyAvailability[]>;
  
  // Provider Blocks CRUD
  getProviderBlocks(providerType: string, providerId: string, startDate: Date, endDate: Date, staffMemberId?: string): Promise<ProviderBlock[]>;
  createProviderBlock(data: InsertProviderBlock): Promise<ProviderBlock>;
  updateProviderBlock(id: string, updates: Partial<ProviderBlock>): Promise<ProviderBlock | undefined>;
  deleteProviderBlock(id: string): Promise<void>;

  // Consumer address book
  getConsumerAddresses(userId: string): Promise<ConsumerAddress[]>;
  createConsumerAddress(data: InsertConsumerAddress): Promise<ConsumerAddress>;
  updateConsumerAddress(id: string, userId: string, data: Partial<InsertConsumerAddress>): Promise<ConsumerAddress>;
  deleteConsumerAddress(id: string, userId: string): Promise<void>;
}

// ==================== UNIFIED SEARCH TYPES ====================

export type SearchScope = 'all' | 'consumers' | 'photographers' | 'businesses' | 'products' | 'services';

export interface UnifiedSearchParams {
  q: string;
  scope: string;
  viewerUserId: string | null;
  city: string | null;
  personalized: boolean;
  limit: number;
  offset: number;
  isAdmin: boolean;
}

export interface UnifiedSearchResult {
  id: string;
  type: 'consumer' | 'photographer' | 'business' | 'product' | 'service' | 'staff';
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  ratingAvg: number | null;
  ratingCount: number | null;
  category: string | null;
  providerUserId: string | null;
  username: string | null;
  baseScore: number;
  personalizationScore: number;
  price?: number | null;
  businessId?: string | null;
  businessName?: string | null;
  productImage?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  providerType?: 'photographer' | 'business' | null;
  isFeatured?: boolean | null;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchResult[];
  total: number;
  personalized: boolean;
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

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(
      sql`LOWER(${users.username}) = LOWER(${username})`
    );
    return result[0];
  }

  async getUserByGoogleSub(googleSub: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.googleSub, googleSub));
    return result[0];
  }

  async getUserByAppleId(appleId: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.appleId, appleId));
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

      username: insertUser.username,
      dateOfBirth: insertUser.dateOfBirth || null,
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
        username: userData.id.slice(0, 20), // temporary username from ID for upsert
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

  async getAdminUsers(): Promise<User[]> {
    const result = await db.select().from(users).where(eq(users.isAdmin, true));
    return result;
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

  async getBusinessByStripeAccountId(stripeAccountId: string): Promise<Business | undefined> {
    const result = await db.select().from(businesses).where(eq(businesses.stripeAccountId, stripeAccountId));
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

  async getBusinessesByApprovalStatus(status: string): Promise<(Business & { owner?: User })[]> {
    const result = await db
      .select({
        business: businesses,
        owner: users,
      })
      .from(businesses)
      .leftJoin(users, eq(businesses.ownerId, users.id))
      .where(eq(businesses.approvalStatus, status))
      .orderBy(desc(businesses.createdAt));

    return result.map(row => ({
      ...row.business,
      owner: row.owner || undefined,
    }));
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
      isMultiStaff: insertBusiness.isMultiStaff ?? false,
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
      vendorAgreementAccepted: insertBusiness.vendorAgreementAccepted ?? false,
      vendorAgreementAcceptedAt: insertBusiness.vendorAgreementAcceptedAt || null,
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
  // OAUTH STATES (Mobile Auth CSRF)
  // =========================

  async createOAuthState(state: string, expiresAt: Date, deviceId?: string): Promise<void> {
    await db.insert(oauthStates).values({
      state,
      expiresAt,
      deviceId: deviceId || null,
    });
  }

  async validateAndConsumeOAuthState(state: string): Promise<{ state: string; deviceId: string | null } | null> {
    // Delete and return the state in one operation (atomic)
    const result = await db.delete(oauthStates)
      .where(
        and(
          eq(oauthStates.state, state),
          sql`${oauthStates.expiresAt} > NOW()`
        )
      )
      .returning();

    if (result.length === 0) {
      return null;
    }

    return {
      state: result[0].state,
      deviceId: result[0].deviceId,
    };
  }

  async cleanupExpiredOAuthStates(): Promise<void> {
    await db.delete(oauthStates).where(
      sql`${oauthStates.expiresAt} < NOW()`
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
      shootLocation: data.shootLocation,
      studioName: data.studioName,
      studioAddress: data.studioAddress,
      usesSharedStudio: data.usesSharedStudio,
      travelRadius: data.travelRadius,
      pricingType: data.pricingType,
      startingPrice: data.startingPrice,
      minimumBooking: data.minimumBooking,
      additionalServices: data.additionalServices,
      experienceLevel: data.experienceLevel,
      equipmentLevel: data.equipmentLevel,
      deliveryTime: data.deliveryTime,
    }).returning();
    return result[0];
  }

  async getPhotographer(id: string): Promise<Photographer | undefined> {
    const result = await db.select().from(photographers).where(eq(photographers.id, id));
    return result[0];
  }

  async listPhotographers(): Promise<Photographer[]> {
    // Public listing: only show photographers with public visibility
    return db.select().from(photographers).where(
      eq(photographers.visibilityStatus, 'public')
    );
  }

  async listAllPhotographers(): Promise<Photographer[]> {
    // Admin/internal: show all photographers regardless of visibility
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

  async getPhotographerByStripeAccountId(stripeAccountId: string): Promise<Photographer | undefined> {
    const result = await db.select().from(photographers).where(eq(photographers.stripeAccountId, stripeAccountId));
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
    // Public: only return live services
    return db.select()
      .from(photographerServices)
      .where(and(
        eq(photographerServices.photographerId, photographerId),
        eq(photographerServices.isActive, true),
        eq(photographerServices.status, 'live')
      ));
  }

  async getAllPhotographerServices(photographerId: string): Promise<PhotographerService[]> {
    // Owner dashboard: return all services regardless of status or isActive
    // This allows owners to see archived and deleted services
    return db.select()
      .from(photographerServices)
      .where(eq(photographerServices.photographerId, photographerId));
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

  // Review time window: 30 days from completion
  private REVIEW_WINDOW_DAYS = 30;

  // Check if a date is within the review window
  private isWithinReviewWindow(completedAt: Date | null): boolean {
    if (!completedAt) return false;
    const now = new Date();
    const windowEnd = new Date(completedAt);
    windowEnd.setDate(windowEnd.getDate() + this.REVIEW_WINDOW_DAYS);
    return now <= windowEnd;
  }

  // Verify customer has a completed booking/order with the target
  // Reviews are locked after 30 days from completion
  async verifyCustomerCanReview(
    customerId: string,
    targetType: string,
    targetId: string,
    bookingType: string,
    bookingId: string
  ): Promise<{ canReview: boolean; reason?: string }> {
    if (!bookingId || bookingId.trim() === '') {
      return { canReview: false, reason: 'No booking reference provided' };
    }

    // Check if already reviewed this booking
    const alreadyReviewed = await this.hasReviewedBooking(bookingType, bookingId);
    if (alreadyReviewed) {
      return { canReview: false, reason: 'You have already reviewed this booking' };
    }

    // Verify the booking exists, belongs to this customer, and is within review window
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
      // Check review time window (use updatedAt as completion timestamp)
      if (!this.isWithinReviewWindow(booking[0].updatedAt)) {
        return { canReview: false, reason: 'Review window has expired (30 days from completion)' };
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
      // Check review time window
      if (!this.isWithinReviewWindow(booking[0].updatedAt)) {
        return { canReview: false, reason: 'Review window has expired (30 days from completion)' };
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
      // Check review time window (use updatedAt as delivery/completion timestamp)
      if (!this.isWithinReviewWindow(order[0].updatedAt)) {
        return { canReview: false, reason: 'Review window has expired (30 days from delivery)' };
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
    draftExpiresAt?: Date | null;
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
        draftExpiresAt: data.draftExpiresAt || null,
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

  // =========================
  // APPOINTMENTS
  // =========================

  async createAppointment(data: InsertAppointment): Promise<Appointment> {
    const id = randomUUID();
    const [appointment] = await db.insert(appointments)
      .values({ id, ...data })
      .returning();
    return appointment;
  }

  async getAppointment(id: string): Promise<Appointment | undefined> {
    const [appointment] = await db.select()
      .from(appointments)
      .where(eq(appointments.id, id));
    return appointment;
  }

  async getAppointmentsByBusiness(businessId: string): Promise<Appointment[]> {
    return db.select()
      .from(appointments)
      .where(eq(appointments.businessId, businessId))
      .orderBy(desc(appointments.createdAt));
  }

  async getAppointmentsByBusinessWithDetails(businessId: string): Promise<{
    id: string;
    customerName: string;
    customerAvatar: string | null;
    date: string;
    time: string;
    serviceName: string | null;
    status: string;
    amount: number;
    subtotalAmount: number;
    bookingFeeAmount: number;
    vendorNetAmount: number;
  }[]> {
    const rows = await db.select({
      id: appointments.id,
      date: appointments.appointmentDate,
      time: appointments.appointmentTime,
      status: appointments.status,
      totalPrice: appointments.totalPrice,
      platformFee: appointments.platformFee,
      vendorNet: appointments.vendorNet,
      name: users.name,
      firstName: users.firstName,
      lastName: users.lastName,
      customerAvatar: users.profileImageUrl,
      serviceName: vendorServices.name,
      staffMemberId: appointments.staffMemberId,
    })
      .from(appointments)
      .leftJoin(users, eq(appointments.clientId, users.id))
      .leftJoin(vendorServices, eq(appointments.serviceId, vendorServices.id))
      .where(eq(appointments.businessId, businessId))
      .orderBy(desc(appointments.createdAt));

    return rows.map((row) => {
      const fullName = row.name || `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();
      return {
        id: row.id,
        customerName: fullName || "Unknown Customer",
        customerAvatar: row.customerAvatar,
        date: row.date,
        time: row.time,
        serviceName: row.serviceName,
        status: row.status,
        amount: (row.totalPrice ?? 0) / 100,
        subtotalAmount: (row.totalPrice ?? 0) / 100,
        bookingFeeAmount: (row.platformFee ?? 0) / 100,
        vendorNetAmount: (row.vendorNet ?? 0) / 100,
        staffMemberId: row.staffMemberId ?? null,
      };
    });
  }

  async getAppointmentsByClient(clientId: string): Promise<Appointment[]> {
    return db.select()
      .from(appointments)
      .where(eq(appointments.clientId, clientId))
      .orderBy(desc(appointments.createdAt));
  }

  async getAppointmentsByClientWithDetails(clientId: string): Promise<{
    id: string;
    appointmentDate: string;
    appointmentTime: string;
    appointmentEndTime: string | null;
    totalPrice: number;
    status: string;
    businessId: string;
    serviceId: string;
    staffMemberId: string | null;
    businessName: string | null;
    businessLogoImage: string | null;
    businessCity: string | null;
    businessState: string | null;
    businessAddress: string | null;
    serviceName: string | null;
    serviceDurationMinutes: number | null;
    staffDisplayName: string | null;
    staffProfileImageUrl: string | null;
  }[]> {
    return db.select({
      id: appointments.id,
      appointmentDate: appointments.appointmentDate,
      appointmentTime: appointments.appointmentTime,
      appointmentEndTime: appointments.appointmentEndTime,
      totalPrice: appointments.totalPrice,
      status: appointments.status,
      businessId: appointments.businessId,
      serviceId: appointments.serviceId,
      staffMemberId: appointments.staffMemberId,
      businessName: businesses.name,
      businessLogoImage: businesses.logoImage,
      businessCity: businesses.city,
      businessState: businesses.state,
      businessAddress: businesses.address,
      serviceName: vendorServices.name,
      serviceDurationMinutes: vendorServices.durationMinutes,
      staffDisplayName: staffMembers.displayName,
      staffProfileImageUrl: staffMembers.profileImageUrl,
      serviceLocationType: vendorServices.serviceLocationType,
      alternateAddress: vendorServices.alternateAddress,
      alternateCity: vendorServices.alternateCity,
      alternateState: vendorServices.alternateState,
      alternateZipCode: vendorServices.alternateZipCode,
      virtualLink: vendorServices.virtualLink,
      fullRefundWindow: vendorServices.fullRefundWindow,
      hasPartialRefund: vendorServices.hasPartialRefund,
      partialRefundWindow: vendorServices.partialRefundWindow,
      partialRefundPercentage: vendorServices.partialRefundPercentage,
      hasCancellationFee: vendorServices.hasCancellationFee,
      cancellationFeeType: vendorServices.cancellationFeeType,
      cancellationFeeAmount: vendorServices.cancellationFeeAmount,
      customerServiceAddress: appointments.customerServiceAddress,
      customerServiceCity: appointments.customerServiceCity,
      customerServiceState: appointments.customerServiceState,
      customerServiceZipCode: appointments.customerServiceZipCode,
    })
      .from(appointments)
      .leftJoin(businesses, eq(appointments.businessId, businesses.id))
      .leftJoin(vendorServices, eq(appointments.serviceId, vendorServices.id))
      .leftJoin(staffMembers, eq(appointments.staffMemberId, staffMembers.id))
      .where(eq(appointments.clientId, clientId))
      .orderBy(desc(appointments.createdAt));
  }

  async getAppointmentsByStaffMember(staffMemberId: string): Promise<Appointment[]> {
    return db.select()
      .from(appointments)
      .where(eq(appointments.staffMemberId, staffMemberId))
      .orderBy(desc(appointments.createdAt));
  }

  async updateAppointment(id: string, updates: Partial<Appointment>): Promise<Appointment | undefined> {
    const [appointment] = await db.update(appointments)
      .set(updates)
      .where(eq(appointments.id, id))
      .returning();
    return appointment;
  }

  // Update appointment with state machine validation and automatic slot release
  async updateAppointmentWithValidation(
    appointmentId: string,
    updates: Partial<Appointment>,
    actorId?: string
  ): Promise<{ success: boolean; appointment?: Appointment; error?: string }> {
    const currentAppointment = await this.getAppointment(appointmentId);
    if (!currentAppointment) {
      return { success: false, error: 'Appointment not found' };
    }

    // Use booking transitions for appointments (similar state machine)
    if (updates.status && updates.status !== currentAppointment.status) {
      if (!isValidBookingTransition(currentAppointment.status || 'pending', updates.status)) {
        return { 
          success: false, 
          error: `Invalid status transition from '${currentAppointment.status}' to '${updates.status}'` 
        };
      }
    }

    const beforeState = { ...currentAppointment };
    const result = await db.update(appointments)
      .set(updates)
      .where(eq(appointments.id, appointmentId))
      .returning();
    
    if (!result[0]) {
      return { success: false, error: 'Failed to update appointment' };
    }

    // Release availability slot when appointment is cancelled or refunded
    if (updates.status && (updates.status === 'cancelled' || updates.status === 'refunded')) {
      await this.releaseBusinessSlot(appointmentId);
    }

    await this.createAuditLog({
      actorId: actorId ?? null,
      actorType: actorId ? 'user' : 'system',
      action: 'appointment_status_change',
      targetType: 'appointment',
      targetId: appointmentId,
      beforeState: beforeState as unknown as Record<string, any>,
      afterState: result[0] as unknown as Record<string, any>,
      metadata: { statusChange: { from: currentAppointment.status, to: updates.status } } as Record<string, any>
    });

    return { success: true, appointment: result[0] };
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

  async getUnreadCountPerConversation(userId: string): Promise<Map<string, number>> {
    // Get all conversations where user is a participant
    const userConvos = await db.select({ id: conversations.id }).from(conversations).where(
      or(
        eq(conversations.participant1Id, userId),
        eq(conversations.participant2Id, userId)
      )
    );

    if (userConvos.length === 0) return new Map();

    const convoIds = userConvos.map(c => c.id);
    
    // Group unread messages by conversation (messages not from this user)
    const unreadPerConvo = await db
      .select({ 
        conversationId: messages.conversationId, 
        count: sql<number>`count(*)` 
      })
      .from(messages)
      .where(
        and(
          sql`${messages.conversationId} IN (${sql.join(convoIds.map(id => sql`${id}`), sql`, `)})`,
          sql`${messages.senderId} != ${userId}`,
          eq(messages.isRead, false)
        )
      )
      .groupBy(messages.conversationId);

    const result = new Map<string, number>();
    for (const row of unreadPerConvo) {
      result.set(row.conversationId, Number(row.count));
    }
    return result;
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

  // Hard cap per transaction (bonus awards bypass pending queue so keep cap here too)
  private readonly MAX_POINTS_PER_TRANSACTION = 5000;

  // Calculate points for a purchase/booking using the canonical formula:
  //   base_charge = consumer_total / 1.08  (reverse the 8% upcharge)
  //   points_earned = base_charge * 0.04 * 100  =  consumer_total_cents * 4 / 108
  //   outsyde_revenue_cents = points_earned  (same numeric value; 100 pts == $1)
  private calcPurchasePoints(consumerTotalCents: number): { pointsEarned: number; outsydeRevenueCents: number } {
    const pointsEarned = Math.round(consumerTotalCents * 4 / 108);
    return { pointsEarned, outsydeRevenueCents: pointsEarned };
  }

  async earnPoints(data: {
    userId: string;
    dollarAmountCents: number;
    transactionType: 'photographer_booking' | 'business_transaction' | 'bonus';
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
  }): Promise<PointTransaction> {
    // Bonus = direct point award (referrals, promotions); purchase/booking = formula-derived.
    const rawPoints = data.transactionType === 'bonus'
      ? data.dollarAmountCents
      : this.calcPurchasePoints(data.dollarAmountCents).pointsEarned;

    const isCapped = rawPoints > this.MAX_POINTS_PER_TRANSACTION;
    const pointsEarned = isCapped ? this.MAX_POINTS_PER_TRANSACTION : rawPoints;

    const currentBalance = await this.getUserPointsBalance(data.userId);
    const newBalance = currentBalance + pointsEarned;

    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, data.userId));

    const result = await db.insert(pointTransactions).values({
      id: randomUUID(),
      userId: data.userId,
      type: 'earn',
      points: pointsEarned,
      dollarAmountCents: data.dollarAmountCents,
      businessId: data.businessId || null,
      businessName: data.businessName || null,
      referenceType: data.referenceType || null,
      referenceId: data.referenceId || null,
      balanceAfter: newBalance,
      description: data.description || `Earned ${pointsEarned} points${isCapped ? ' (capped)' : ''}`,
      capped: isCapped,
    }).returning();

    return result[0];
  }

  async getPendingPointTransactions(opts: { userId?: string; status?: string; limit?: number } = {}): Promise<PendingPointTransaction[]> {
    const { userId, status = 'pending', limit = 100 } = opts;
    const conditions = [eq(pendingPointTransactions.status, status)];
    if (userId) conditions.push(eq(pendingPointTransactions.userId, userId));

    return db.select()
      .from(pendingPointTransactions)
      .where(and(...conditions))
      .orderBy(desc(pendingPointTransactions.createdAt))
      .limit(limit);
  }

  async approvePendingPointTransaction(pendingId: string, reviewerId: string, note?: string): Promise<{ pending: PendingPointTransaction; live: PointTransaction }> {
    const [pending] = await db.select().from(pendingPointTransactions).where(eq(pendingPointTransactions.id, pendingId));
    if (!pending) throw new Error(`Pending transaction ${pendingId} not found`);
    if (pending.status !== 'pending') throw new Error(`Transaction ${pendingId} is already ${pending.status}`);

    const pointsToCredit = Math.min(pending.pointsEarned, this.MAX_POINTS_PER_TRANSACTION);
    const isCapped = pointsToCredit < pending.pointsEarned;

    const currentBalance = await this.getUserPointsBalance(pending.userId);
    const newBalance = currentBalance + pointsToCredit;

    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, pending.userId));

    const liveId = randomUUID();
    const [live] = await db.insert(pointTransactions).values({
      id: liveId,
      userId: pending.userId,
      type: 'earn',
      points: pointsToCredit,
      dollarAmountCents: pending.dollarAmountCents,
      businessId: pending.businessId || null,
      businessName: pending.businessName || null,
      referenceType: pending.referenceType || null,
      referenceId: pending.referenceId || null,
      balanceAfter: newBalance,
      description: pending.description || `Earned ${pointsToCredit} points`,
      capped: isCapped,
    }).returning();

    const now = new Date();
    const [updatedPending] = await db.update(pendingPointTransactions)
      .set({ status: 'approved', reviewedAt: now, reviewedBy: reviewerId, reviewNote: note || null, liveTransactionId: liveId, updatedAt: now })
      .where(eq(pendingPointTransactions.id, pendingId))
      .returning();

    return { pending: updatedPending, live };
  }

  async rejectPendingPointTransaction(pendingId: string, reviewerId: string, note?: string): Promise<PendingPointTransaction> {
    const [pending] = await db.select().from(pendingPointTransactions).where(eq(pendingPointTransactions.id, pendingId));
    if (!pending) throw new Error(`Pending transaction ${pendingId} not found`);
    if (pending.status !== 'pending') throw new Error(`Transaction ${pendingId} is already ${pending.status}`);

    const now = new Date();
    const [updated] = await db.update(pendingPointTransactions)
      .set({ status: 'rejected', reviewedAt: now, reviewedBy: reviewerId, reviewNote: note || null, updatedAt: now })
      .where(eq(pendingPointTransactions.id, pendingId))
      .returning();

    return updated;
  }

  // Fixed redemption tiers - NO custom amounts allowed
  private readonly REDEMPTION_TIERS = [
    { points: 500,   valueCents: 500 },
    { points: 1000,  valueCents: 1000 },
    { points: 2500,  valueCents: 2500 },
    { points: 5000,  valueCents: 5000 },
    { points: 10000, valueCents: 10000 },
    { points: 25000, valueCents: 25000 }
  ];
  
  // Max discount as percentage of order total
  private readonly MAX_REDEMPTION_PERCENT = 30;

  async redeemPoints(data: {
    userId: string;
    points: number;
    orderTotalCents?: number; // Required for 30% cap validation
    businessId?: string;
    businessName?: string;
    referenceType?: string;
    referenceId?: string;
    description?: string;
    isFirstBooking?: boolean; // Block redemption on first-time bookings
    isDeposit?: boolean; // Block redemption on deposits
    isSubscription?: boolean; // Block redemption on subscriptions
  }): Promise<{ transaction: PointTransaction; discountCents: number } | { error: string }> {
    // TIER-BASED REDEMPTION: Only allow fixed tier amounts
    const tier = this.REDEMPTION_TIERS.find(t => t.points === data.points);
    if (!tier) {
      const validTiers = this.REDEMPTION_TIERS.map(t => t.points).join(', ');
      return { error: `Invalid redemption amount. Points must be one of: ${validTiers}` };
    }
    
    // MAX 1 REDEMPTION PER TRANSACTION: Check if already redeemed for this referenceId
    if (data.referenceId) {
      const existingRedemptions = await db.select()
        .from(pointTransactions)
        .where(and(
          eq(pointTransactions.userId, data.userId),
          eq(pointTransactions.referenceId, data.referenceId),
          eq(pointTransactions.type, 'redeem')
        ));
      
      if (existingRedemptions.length > 0) {
        return { error: 'Only one redemption allowed per transaction' };
      }
    }
    
    // Block redemption on restricted transaction types
    if (data.isDeposit) {
      return { error: 'Points cannot be redeemed on deposits' };
    }
    if (data.isFirstBooking) {
      return { error: 'Points cannot be redeemed on first-time bookings' };
    }
    if (data.isSubscription) {
      return { error: 'Points cannot be redeemed on subscription payments' };
    }
    
    // Check user has enough points
    const currentBalance = await this.getUserPointsBalance(data.userId);
    
    if (data.points > currentBalance) {
      return { error: `Insufficient points. You have ${currentBalance} points but tried to redeem ${data.points}` };
    }

    // Validate 30% max of order total (if order total provided)
    if (data.orderTotalCents) {
      const maxDiscountCents = Math.floor(data.orderTotalCents * this.MAX_REDEMPTION_PERCENT / 100);
      if (tier.valueCents > maxDiscountCents) {
        return { error: `Redemption value cannot exceed 30% of order total. Max allowed: $${(maxDiscountCents / 100).toFixed(2)}` };
      }
    }

    const discountCents = tier.valueCents;
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
      capped: false,
    }).returning();

    return { 
      transaction: result[0], 
      discountCents 
    };
  }
  
  // Get available redemption tiers for a user based on their balance
  getAvailableRedemptionTiers(balance: number): { points: number; valueCents: number }[] {
    return this.REDEMPTION_TIERS.filter(tier => tier.points <= balance);
  }

  // Reverse points for refunds and cancellations
  async reversePoints(data: {
    userId: string;
    originalTransactionId: string;
    reason: string;
  }): Promise<PointTransaction | { error: string }> {
    // Find the original transaction
    const [originalTransaction] = await db.select()
      .from(pointTransactions)
      .where(eq(pointTransactions.id, data.originalTransactionId));
    
    if (!originalTransaction) {
      return { error: 'Original transaction not found' };
    }
    
    if (originalTransaction.userId !== data.userId) {
      return { error: 'Transaction does not belong to this user' };
    }
    
    // Check if already reversed (look for existing reversal)
    const existingReversals = await db.select()
      .from(pointTransactions)
      .where(and(
        eq(pointTransactions.referenceId, data.originalTransactionId),
        eq(pointTransactions.type, 'reversal')
      ));
    
    if (existingReversals.length > 0) {
      return { error: 'Transaction has already been reversed' };
    }
    
    const currentBalance = await this.getUserPointsBalance(data.userId);
    let newBalance: number;
    let pointsToReverse: number;
    
    if (originalTransaction.type === 'earn') {
      // Earned points being reversed = subtract from balance
      pointsToReverse = -originalTransaction.points;
      newBalance = Math.max(0, currentBalance - originalTransaction.points);
    } else if (originalTransaction.type === 'redeem') {
      // Redeemed points being reversed = add back to balance
      pointsToReverse = originalTransaction.points;
      newBalance = currentBalance + originalTransaction.points;
    } else {
      return { error: 'Cannot reverse a reversal transaction' };
    }
    
    // Update user's balance
    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, data.userId));
    
    // Create reversal transaction record
    const id = randomUUID();
    const result = await db.insert(pointTransactions).values({
      id,
      userId: data.userId,
      type: 'reversal',
      points: pointsToReverse,
      dollarAmountCents: originalTransaction.dollarAmountCents,
      businessId: originalTransaction.businessId,
      businessName: originalTransaction.businessName,
      referenceType: 'reversal',
      referenceId: data.originalTransactionId,
      balanceAfter: newBalance,
      description: `Reversal: ${data.reason}`,
      capped: false,
    }).returning();
    
    return result[0];
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
  // REFERRAL SYSTEM (Deferred Rewards)
  // =========================
  // Referrer bonus is ONLY paid after referred user completes first transaction
  // Referred user gets welcome bonus immediately upon applying code

  private readonly REFERRAL_BONUS_POINTS = 500; // $5 for referrer (paid after first transaction)
  private readonly NEW_USER_REFERRAL_BONUS = 250; // $2.50 for new user (paid immediately)
  private readonly MAX_SUCCESSFUL_REFERRALS = 50; // One-to-many abuse prevention

  async generateReferralCode(userId: string): Promise<string> {
    const user = await this.getUser(userId);
    if (user?.referralCode) {
      return user.referralCode;
    }

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const existing = await this.getUserByReferralCode(code);
    if (existing) {
      return this.generateReferralCode(userId);
    }

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

  async getSuccessfulReferralCount(referrerId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(referrals)
      .where(and(
        eq(referrals.referrerId, referrerId),
        eq(referrals.status, 'completed')
      ));
    return Number(result[0]?.count || 0);
  }

  async processReferral(newUserId: string, referralCode: string): Promise<{ success: boolean; referrerId?: string; error?: string }> {
    const referrer = await this.getUserByReferralCode(referralCode);
    if (!referrer) {
      return { success: false, error: 'Invalid referral code' };
    }

    // Self-referral prevention
    if (referrer.id === newUserId) {
      return { success: false, error: 'You cannot use your own referral code' };
    }

    // Check if user was already referred
    const newUser = await this.getUser(newUserId);
    if (newUser?.referredBy) {
      return { success: false, error: 'You have already used a referral code' };
    }

    // Check existing referral record
    const existingReferral = await this.getPendingReferral(newUserId);
    if (existingReferral) {
      return { success: false, error: 'Referral already applied' };
    }

    // One-to-many abuse prevention: limit referrals per user
    const successfulCount = await this.getSuccessfulReferralCount(referrer.id);
    if (successfulCount >= this.MAX_SUCCESSFUL_REFERRALS) {
      return { success: false, error: 'Referrer has reached the maximum number of referrals' };
    }

    // Mark the new user as referred
    await db.update(users)
      .set({ referredBy: referrer.id })
      .where(eq(users.id, newUserId));

    // Create pending referral record (referrer bonus is deferred)
    const referralId = randomUUID();
    await db.insert(referrals).values({
      id: referralId,
      referrerId: referrer.id,
      referredUserId: newUserId,
      status: 'pending',
      referrerBonusPoints: this.REFERRAL_BONUS_POINTS,
      referredBonusPoints: this.NEW_USER_REFERRAL_BONUS,
    });

    // Award welcome bonus to new user immediately
    await this.earnPoints({
      userId: newUserId,
      dollarAmountCents: this.NEW_USER_REFERRAL_BONUS,
      transactionType: 'bonus',
      referenceType: 'referral_welcome',
      referenceId: referrer.id,
      description: `Welcome bonus for joining via referral`,
    });

    // Update referral record to mark referred bonus as paid
    await db.update(referrals)
      .set({ referredBonusPaidAt: new Date() })
      .where(eq(referrals.id, referralId));

    return { success: true, referrerId: referrer.id };
  }

  async getPendingReferral(referredUserId: string): Promise<Referral | undefined> {
    const result = await db.select()
      .from(referrals)
      .where(eq(referrals.referredUserId, referredUserId));
    return result[0];
  }

  async completeReferral(referredUserId: string, transactionId: string, transactionType: string): Promise<{ success: boolean; error?: string }> {
    // Find the pending referral for this user
    const referral = await this.getPendingReferral(referredUserId);
    
    if (!referral) {
      return { success: false, error: 'No referral found for this user' };
    }

    if (referral.status === 'completed') {
      return { success: false, error: 'Referral already completed' };
    }

    // Award bonus to referrer now that referred user has completed a transaction
    await this.earnPoints({
      userId: referral.referrerId,
      dollarAmountCents: referral.referrerBonusPoints,
      transactionType: 'bonus',
      referenceType: 'referral',
      referenceId: referredUserId,
      description: `Referral bonus - your friend completed their first purchase!`,
    });

    // Update referral record to completed
    await db.update(referrals)
      .set({
        status: 'completed',
        referrerBonusPaidAt: new Date(),
        firstTransactionId: transactionId,
        firstTransactionType: transactionType,
      })
      .where(eq(referrals.id, referral.id));

    console.log(`Referral completed: referrer ${referral.referrerId} earned ${referral.referrerBonusPoints} points for referring ${referredUserId}`);

    return { success: true };
  }

  async getReferralStats(userId: string): Promise<{ totalReferrals: number; completedReferrals: number; pendingReferrals: number; totalPointsEarned: number }> {
    const allReferrals = await db.select()
      .from(referrals)
      .where(eq(referrals.referrerId, userId));
    
    const completed = allReferrals.filter(r => r.status === 'completed');
    const pending = allReferrals.filter(r => r.status === 'pending');
    const totalPointsEarned = completed.reduce((sum, r) => sum + r.referrerBonusPoints, 0);

    return {
      totalReferrals: allReferrals.length,
      completedReferrals: completed.length,
      pendingReferrals: pending.length,
      totalPointsEarned,
    };
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
    return db.select().from(orders).where(eq(orders.customerId, userId));
  }

  async getProductImagesByIds(productIds: string[]): Promise<Record<string, string | null>> {
    if (productIds.length === 0) return {};
    const rows = await db
      .select({ id: vendorProducts.id, imageUrl: vendorProducts.imageUrl })
      .from(vendorProducts)
      .where(inArray(vendorProducts.id, productIds));
    return Object.fromEntries(rows.map((r) => [r.id, r.imageUrl ?? null]));
  }

  async getUserBookings(userId: string): Promise<ShootBooking[]> {
    return db.select().from(shootBookings).where(eq(shootBookings.clientId, userId));
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, orderId));
    return result[0];
  }

  async getVendorOrders(businessId: string): Promise<(Order & { customerName: string })[]> {
    const rows = await db
      .select()
      .from(orders)
      .leftJoin(users, eq(orders.customerId, users.id))
      .where(eq(orders.businessId, businessId));
    return rows.map(({ orders: order, users: user }) => ({
      ...order,
      customerName: user
        ? (user.name || [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || user.email || "Customer")
        : "Unknown",
    }));
  }

  async createOrder(data: InsertOrder): Promise<Order> {
    const [order] = await db.insert(orders).values(data).returning();
    return order;
  }

  async getUserByBusinessOwnerId(businessId: string): Promise<User | undefined> {
    const business = await this.getBusiness(businessId);
    if (!business) return undefined;
    return this.getUser(business.ownerId);
  }

  async getShootBooking(id: string): Promise<ShootBooking | undefined> {
    const result = await db.select().from(shootBookings).where(eq(shootBookings.id, id));
    return result[0];
  }

  async updateShootBooking(id: string, updates: Partial<ShootBooking>): Promise<ShootBooking | undefined> {
    const result = await db.update(shootBookings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(shootBookings.id, id))
      .returning();
    return result[0];
  }

  async getShootBookingByCheckoutSession(sessionId: string): Promise<ShootBooking | undefined> {
    const result = await db.select().from(shootBookings).where(eq(shootBookings.stripeCheckoutSessionId, sessionId));
    return result[0];
  }

  async updateOrder(orderId: string, updates: Partial<Order>): Promise<Order | undefined> {
    const result = await db.update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    return result[0];
  }

  async getPhotographerBookings(photographerId: string): Promise<ShootBooking[]> {
    return db.select().from(shootBookings).where(eq(shootBookings.photographerId, photographerId));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId));
  }

  async getOrderByCheckoutSession(sessionId: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.stripeCheckoutSessionId, sessionId));
    return result[0];
  }

  // =========================
  // ORDER GROUPS (Multi-Vendor Cart)
  // =========================

  async createOrderGroup(data: InsertOrderGroup): Promise<OrderGroup> {
    const [group] = await db.insert(orderGroups).values(data).returning();
    return group;
  }

  async getOrderGroup(id: string): Promise<OrderGroup | undefined> {
    const result = await db.select().from(orderGroups).where(eq(orderGroups.id, id));
    return result[0];
  }

  async updateOrderGroup(id: string, updates: Partial<OrderGroup>): Promise<OrderGroup | undefined> {
    const result = await db.update(orderGroups)
      .set(updates)
      .where(eq(orderGroups.id, id))
      .returning();
    return result[0];
  }

  async getOrderGroupOrders(orderGroupId: string): Promise<Order[]> {
    return db.select().from(orders).where(eq(orders.orderGroupId, orderGroupId));
  }

  async getNextPendingOrderInGroup(orderGroupId: string): Promise<Order | undefined> {
    const result = await db.select()
      .from(orders)
      .where(and(
        eq(orders.orderGroupId, orderGroupId),
        eq(orders.status, 'pending')
      ))
      .limit(1);
    return result[0];
  }

  // =========================
  // USER BLOCKING
  // =========================

  async blockUser(blockerId: string, blockedId: string, reason?: string): Promise<UserBlock> {
    const existing = await db.select().from(userBlocks).where(
      and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId))
    );
    if (existing[0]) {
      return existing[0];
    }
    const [block] = await db.insert(userBlocks).values({
      blockerId,
      blockedId,
      reason: reason || null,
    }).returning();
    return block;
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await db.delete(userBlocks).where(
      and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId))
    ).returning();
    return result.length > 0;
  }

  async isUserBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await db.select().from(userBlocks).where(
      and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId))
    );
    return result.length > 0;
  }

  async isUserBlockedEitherWay(userId1: string, userId2: string): Promise<boolean> {
    const result = await db.select().from(userBlocks).where(
      or(
        and(eq(userBlocks.blockerId, userId1), eq(userBlocks.blockedId, userId2)),
        and(eq(userBlocks.blockerId, userId2), eq(userBlocks.blockedId, userId1))
      )
    );
    return result.length > 0;
  }

  async getBlockedUsers(userId: string): Promise<UserBlock[]> {
    return db.select().from(userBlocks).where(eq(userBlocks.blockerId, userId)).orderBy(desc(userBlocks.createdAt));
  }

  // =========================
  // MESSAGE REPORTS
  // =========================

  async createMessageReport(data: InsertMessageReport): Promise<MessageReport> {
    const [report] = await db.insert(messageReports).values(data).returning();
    return report;
  }

  async getMessageReports(filters?: { status?: string; reporterId?: string; reportedUserId?: string }): Promise<MessageReport[]> {
    let conditions = [];
    if (filters?.status) {
      conditions.push(eq(messageReports.status, filters.status));
    }
    if (filters?.reporterId) {
      conditions.push(eq(messageReports.reporterId, filters.reporterId));
    }
    if (filters?.reportedUserId) {
      conditions.push(eq(messageReports.reportedUserId, filters.reportedUserId));
    }
    if (conditions.length > 0) {
      return db.select().from(messageReports).where(and(...conditions)).orderBy(desc(messageReports.createdAt));
    }
    return db.select().from(messageReports).orderBy(desc(messageReports.createdAt));
  }

  async updateMessageReport(id: string, updates: Partial<MessageReport>): Promise<MessageReport | undefined> {
    const [report] = await db.update(messageReports).set(updates).where(eq(messageReports.id, id)).returning();
    return report;
  }

  async getMessageReport(id: string): Promise<MessageReport | undefined> {
    const result = await db.select().from(messageReports).where(eq(messageReports.id, id));
    return result[0];
  }

  // =========================
  // UNIFIED SEARCH INDEX
  // =========================

  async upsertSearchIndexEntry(entry: InsertSearchIndexEntry): Promise<SearchIndexEntry> {
    const existing = await db.select().from(searchIndex)
      .where(and(
        eq(searchIndex.entityType, entry.entityType),
        eq(searchIndex.entityId, entry.entityId)
      ));
    
    if (existing.length > 0) {
      const [updated] = await db.update(searchIndex)
        .set({
          userId: entry.userId,
          name: entry.name,
          description: entry.description,
          category: entry.category,
          tags: entry.tags ? [...entry.tags] : null,
          knownFor: entry.knownFor ? [...entry.knownFor] : null,
          city: entry.city,
          state: entry.state,
          latitude: entry.latitude,
          longitude: entry.longitude,
          rating: entry.rating,
          reviewCount: entry.reviewCount,
          priceCents: entry.priceCents,
          imageUrl: entry.imageUrl,
          isActive: entry.isActive,
          parentType: entry.parentType,
          parentId: entry.parentId,
          hasActiveSubscription: entry.hasActiveSubscription,
          isDemo: entry.isDemo ?? false,
          updatedAt: new Date(),
        })
        .where(eq(searchIndex.id, existing[0].id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(searchIndex).values({
      id: randomUUID(),
      entityType: entry.entityType,
      entityId: entry.entityId,
      userId: entry.userId,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      tags: entry.tags ? [...entry.tags] : null,
      knownFor: entry.knownFor ? [...entry.knownFor] : null,
      city: entry.city,
      state: entry.state,
      latitude: entry.latitude,
      longitude: entry.longitude,
      rating: entry.rating,
      reviewCount: entry.reviewCount,
      priceCents: entry.priceCents,
      imageUrl: entry.imageUrl,
      isActive: entry.isActive,
      parentType: entry.parentType,
      parentId: entry.parentId,
      hasActiveSubscription: entry.hasActiveSubscription,
      isDemo: entry.isDemo ?? false,
    }).returning();
    return created;
  }

  async deleteSearchIndexEntry(entityType: string, entityId: string): Promise<void> {
    await db.delete(searchIndex)
      .where(and(
        eq(searchIndex.entityType, entityType),
        eq(searchIndex.entityId, entityId)
      ));
  }

  async rebuildSearchIndex(): Promise<void> {
    await db.delete(searchIndex);
    
    const allBusinesses = await db.select().from(businesses);
    for (const business of allBusinesses) {
      await this.upsertSearchIndexEntry({
        entityType: 'business',
        entityId: business.id,
        userId: business.ownerId,
        name: business.name,
        description: business.description || undefined,
        category: business.category,
        knownFor: (business as any).knownFor || [],
        city: business.city || undefined,
        state: business.state || undefined,
        latitude: business.latitude || undefined,
        longitude: business.longitude || undefined,
        rating: business.rating || 0,
        reviewCount: business.reviewCount || 0,
        imageUrl: business.logoImage || business.coverImage || undefined,
        isActive: business.subscriptionActive || false,
        hasActiveSubscription: business.subscriptionActive || false,
        isDemo: business.isDemo || false,
      });
      
      const products = await db.select().from(vendorProducts)
        .where(and(
          eq(vendorProducts.businessId, business.id),
          eq(vendorProducts.isActive, true),
          eq(vendorProducts.status, 'live')
        ));
      for (const product of products) {
        await this.upsertSearchIndexEntry({
          entityType: 'product',
          entityId: product.id,
          parentType: 'business',
          parentId: business.id,
          name: product.name,
          description: product.description || undefined,
          category: product.category || undefined,
          tags: product.tags || undefined,
          knownFor: (business as any).knownFor || [],
          city: business.city || undefined,
          state: business.state || undefined,
          latitude: business.latitude || undefined,
          longitude: business.longitude || undefined,
          rating: business.rating || 0,
          reviewCount: business.reviewCount || 0,
          priceCents: product.price,
          imageUrl: product.imageUrl || undefined,
          isActive: product.isActive || false,
          hasActiveSubscription: business.subscriptionActive || false,
          isDemo: business.isDemo || false,
        });
      }
      
      const services = await db.select().from(vendorServices)
        .where(and(
          eq(vendorServices.businessId, business.id),
          eq(vendorServices.isActive, true),
          eq(vendorServices.status, 'live')
        ));
      for (const service of services) {
        await this.upsertSearchIndexEntry({
          entityType: 'service',
          entityId: service.id,
          parentType: 'business',
          parentId: business.id,
          name: service.name,
          description: service.description || undefined,
          category: service.category || undefined,
          knownFor: (business as any).knownFor || [],
          city: business.city || undefined,
          state: business.state || undefined,
          latitude: business.latitude || undefined,
          longitude: business.longitude || undefined,
          rating: business.rating || 0,
          reviewCount: business.reviewCount || 0,
          priceCents: service.price,
          isActive: service.isActive || false,
          hasActiveSubscription: business.subscriptionActive || false,
          isDemo: business.isDemo || false,
        });
      }
    }
    
    const allPhotographers = await db.select().from(photographers);
    for (const photographer of allPhotographers) {
      await this.upsertSearchIndexEntry({
        entityType: 'photographer',
        entityId: photographer.id,
        userId: photographer.userId,
        name: photographer.displayName,
        description: photographer.bio || undefined,
        category: photographer.specialties?.join(', ') || undefined,
        city: photographer.city || undefined,
        state: photographer.state || undefined,
        latitude: photographer.latitude || undefined,
        longitude: photographer.longitude || undefined,
        rating: photographer.rating || 0,
        reviewCount: photographer.reviewCount || 0,
        priceCents: photographer.hourlyRate * 100,
        imageUrl: photographer.logoImage || photographer.coverImage || undefined,
        isActive: photographer.stripeOnboardingComplete || false,
        isDemo: photographer.isDemo || false,
      });
      
      const photoServices = await db.select().from(photographerServices)
        .where(and(
          eq(photographerServices.photographerId, photographer.id),
          eq(photographerServices.isActive, true),
          eq(photographerServices.status, 'live')
        ));
      for (const service of photoServices) {
        await this.upsertSearchIndexEntry({
          entityType: 'photographer_service',
          entityId: service.id,
          parentType: 'photographer',
          parentId: photographer.id,
          name: service.name,
          description: service.description || undefined,
          category: service.category || undefined,
          city: photographer.city || undefined,
          state: photographer.state || undefined,
          latitude: photographer.latitude || undefined,
          longitude: photographer.longitude || undefined,
          rating: photographer.rating || 0,
          reviewCount: photographer.reviewCount || 0,
          priceCents: service.priceCents || (service.hourlyRateCents ? service.hourlyRateCents : undefined),
          isActive: service.isActive || false,
          isDemo: photographer.isDemo || false,
        });
      }
    }
    
    console.log("[search] Rebuilt unified search index");
  }

  async unifiedSearch(params: {
    query?: string;
    city?: string;
    category?: string;
    entityTypes?: string[];
    userLatitude?: number;
    userLongitude?: number;
    userPreferences?: {
      selectedIndustries?: string[];
      industryNiches?: Record<string, string[]>;
      industryValues?: Record<string, string[]>;
    };
    limit?: number;
    offset?: number;
    isAdmin?: boolean;
  }): Promise<{ results: SearchIndexEntry[]; total: number }> {
    const { query, city, category, entityTypes, userLatitude, userLongitude, userPreferences, limit = 50, offset = 0, isAdmin = false } = params;
    
    let conditions: any[] = [eq(searchIndex.isActive, true)];
    
    // Hide demo data from non-admin users
    if (!isAdmin) {
      conditions.push(eq(searchIndex.isDemo, false));
    }
    
    if (query) {
      conditions.push(
        or(
          ilike(searchIndex.name, `%${query}%`),
          ilike(searchIndex.description, `%${query}%`),
          ilike(searchIndex.category, `%${query}%`),
          sql`${searchIndex.knownFor}::text ILIKE ${'%' + query + '%'}`
        )
      );
    }
    
    if (city) {
      conditions.push(ilike(searchIndex.city, `%${city}%`));
    }
    
    if (category) {
      conditions.push(ilike(searchIndex.category, `%${category}%`));
    }
    
    if (entityTypes && entityTypes.length > 0) {
      conditions.push(
        or(...entityTypes.map(t => eq(searchIndex.entityType, t)))
      );
    }
    
    const countResult = await db.select({ count: sql<number>`count(*)` })
      .from(searchIndex)
      .where(and(...conditions));
    const total = Number(countResult[0]?.count || 0);

    // Build distance expression for SQL ordering
    let distanceExpr: any = sql`99999`;
    if (userLatitude !== undefined && userLongitude !== undefined) {
      distanceExpr = sql`
        CASE 
          WHEN ${searchIndex.latitude} IS NOT NULL AND ${searchIndex.longitude} IS NOT NULL 
          THEN (
            6371 * acos(
              LEAST(1.0, GREATEST(-1.0,
                cos(radians(${userLatitude})) * cos(radians(${searchIndex.latitude})) *
                cos(radians(${searchIndex.longitude}) - radians(${userLongitude})) +
                sin(radians(${userLatitude})) * sin(radians(${searchIndex.latitude}))
              ))
            )
          )
          ELSE 99999
        END
      `;
    }

    // Standard SQL ordering (without preference matching - that's done in JS for safety)
    let orderBy: any[];
    if (userLatitude !== undefined && userLongitude !== undefined) {
      orderBy = [
        desc(searchIndex.hasActiveSubscription),
        desc(searchIndex.rating),
        asc(distanceExpr)
      ];
    } else {
      orderBy = [
        desc(searchIndex.hasActiveSubscription),
        desc(searchIndex.rating),
        desc(searchIndex.reviewCount)
      ];
    }
    
    // Fetch more results if personalization is enabled so we can re-rank them
    const fetchLimit = userPreferences ? Math.max(limit * 3, 150) : limit;
    
    let results = await db.select().from(searchIndex)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(fetchLimit)
      .offset(offset);

    // Apply preference-based ranking in JavaScript (safe from SQL injection)
    if (userPreferences && results.length > 0) {
      const allNiches: string[] = [];
      const allIndustries = (userPreferences.selectedIndustries || []).map(i => i.toLowerCase());
      
      // Flatten all niches from industryNiches map
      if (userPreferences.industryNiches) {
        for (const niches of Object.values(userPreferences.industryNiches)) {
          allNiches.push(...niches.map(n => n.toLowerCase()));
        }
      }
      
      if (allNiches.length > 0 || allIndustries.length > 0) {
        // Calculate preference score for each result
        const scoredResults = results.map(result => {
          let score = 0;
          const category = (result.category || '').toLowerCase();
          const name = (result.name || '').toLowerCase();
          const description = (result.description || '').toLowerCase();
          
          // Score 2 for matching a specific niche (in category or name)
          for (const niche of allNiches) {
            if (category.includes(niche) || name.includes(niche)) {
              score = Math.max(score, 2);
            } else if (description.includes(niche)) {
              score = Math.max(score, 1);
            }
          }
          
          // Score 1 for matching industry (if no higher score already)
          if (score < 2) {
            for (const industry of allIndustries) {
              if (category.includes(industry)) {
                score = Math.max(score, 1);
              }
            }
          }
          
          return { ...result, _preferenceScore: score };
        });
        
        // Sort by preference score first, then maintain original ordering within same score
        scoredResults.sort((a, b) => {
          if (b._preferenceScore !== a._preferenceScore) {
            return b._preferenceScore - a._preferenceScore;
          }
          // Maintain original SQL ordering for same preference score
          return 0;
        });
        
        // Remove internal score field and apply limit
        results = scoredResults.slice(0, limit).map(({ _preferenceScore, ...rest }) => rest) as SearchIndexEntry[];
      } else {
        // No preferences to apply, just limit
        results = results.slice(0, limit);
      }
    }

    // ADDITIVE: Consumer discovery support (when "consumer" entityType is requested)
    // Consumers are not in searchIndex, so we query users table directly
    // This is handled SEPARATELY to maintain API semantics for existing search behavior
    const includesConsumerType = entityTypes && entityTypes.includes("consumer");
    const onlyConsumerType = includesConsumerType && entityTypes?.length === 1;
    
    if (includesConsumerType) {
      let consumerConditions: any[] = [
        eq(users.isVendor, false),
        eq(users.isPhotographer, false),
      ];
      
      // Hide demo users from non-admins
      if (!isAdmin) {
        consumerConditions.push(sql`NOT (${users.id}::text ILIKE '%demo%')`);
      }
      
      // City-based filtering for consumers
      if (city) {
        consumerConditions.push(ilike(users.city, `%${city}%`));
      }
      
      // Text query matching for consumers
      if (query) {
        consumerConditions.push(
          or(
            ilike(users.username, `%${query}%`),
            ilike(users.name, `%${query}%`),
            ilike(users.firstName, `%${query}%`),
            ilike(users.lastName, `%${query}%`)
          )
        );
      }
      
      // Get consumer count for accurate total
      const consumerCountResult = await db.select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(...consumerConditions));
      const consumerTotal = Number(consumerCountResult[0]?.count || 0);
      
      // Calculate how many consumers to fetch based on remaining limit
      const existingResultCount = results.length;
      const remainingLimit = onlyConsumerType ? limit : Math.max(0, limit - existingResultCount);
      
      const consumerResults = await db.select().from(users)
        .where(and(...consumerConditions))
        .orderBy(desc(users.createdAt)) // Deterministic ordering by creation date
        .limit(remainingLimit)
        .offset(onlyConsumerType ? offset : 0);
      
      // Transform to SearchIndexEntry format
      const consumerEntries: SearchIndexEntry[] = consumerResults.map(user => ({
        id: `consumer-${user.id}`, // Virtual ID for consumers
        entityType: "consumer",
        entityId: user.id,
        parentType: null,
        parentId: null,
        userId: user.id,
        name: user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.username || 'User',
        description: user.username ? `@${user.username}` : null,
        category: null,
        tags: null,
        city: user.city || null,
        state: user.state || null,
        latitude: user.latitude || null,
        longitude: user.longitude || null,
        imageUrl: user.profileImageUrl || null,
        priceCents: null,
        rating: null,
        reviewCount: null,
        knownFor: null,
        isActive: true,
        isDemo: user.id.toLowerCase().includes("demo"),
        hasActiveSubscription: false,
        updatedAt: new Date(),
      }));
      
      // Merge consumer results with searchIndex results
      results = [...results, ...consumerEntries];
      
      // If only consumers are requested, return just consumers with proper pagination
      if (onlyConsumerType) {
        return { results: consumerEntries, total: consumerTotal };
      }
      
      // For mixed results, cap at limit and update total
      results = results.slice(0, limit);
      return { results, total: total + consumerTotal };
    }
    
    return { results, total };
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
      { id: "demo-owner-1", email: "demo1@outsyde.com", password: "demo", name: "Demo Owner 1", username: "demo_owner_1", isVendor: true },
      { id: "demo-owner-2", email: "demo2@outsyde.com", password: "demo", name: "Demo Owner 2", username: "demo_owner_2", isVendor: true },
      { id: "demo-owner-3", email: "demo3@outsyde.com", password: "demo", name: "Demo Owner 3", username: "demo_owner_3", isVendor: true },
      { id: "demo-owner-4", email: "demo4@outsyde.com", password: "demo", name: "Demo Owner 4", username: "demo_owner_4", isVendor: true },
      { id: "demo-owner-5", email: "demo5@outsyde.com", password: "demo", name: "Demo Owner 5", username: "demo_owner_5", isVendor: true },
      { id: "demo-owner-6", email: "demo6@outsyde.com", password: "demo", name: "Demo Owner 6", username: "demo_owner_6", isVendor: true },
      { id: "demo-owner-7", email: "demo7@outsyde.com", password: "demo", name: "Demo Owner 7", username: "demo_owner_7", isVendor: true },
      { id: "demo-owner-8", email: "demo8@outsyde.com", password: "demo", name: "Demo Owner 8", username: "demo_owner_8", isVendor: true },
    ];

    for (const demoUser of demoUsers) {
      await db.insert(users).values({
        id: demoUser.id,
        email: demoUser.email,
        password: demoUser.password,
        name: demoUser.name,
        username: demoUser.username,
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
        isDemo: true,
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
        isDemo: true,
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
        isDemo: true,
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
        isDemo: true,
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
        isDemo: true,
      },
      {
        ownerId: "demo-owner-6",
        name: "Urban Cuts Barbershop",
        category: "Beauty",
        description: "Classic cuts and modern styles for men.",
        isStartup: false,
        isDemo: true,
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
        isDemo: true,
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
        isDemo: true,
      },
    ];

    for (const business of sampleBusinesses) {
      await db.insert(businesses).values({
        id: randomUUID(),
        ownerId: business.ownerId,
        name: business.name,
        category: business.category,
        description: business.description,
        isStartup: business.isStartup,
        yearsInBusiness: business.yearsInBusiness,
        employeeCount: business.employeeCount,
        businessType: business.businessType,
        hasPhysicalLocation: business.hasPhysicalLocation,
        address: business.address,
        city: business.city,
        state: business.state,
        zipCode: business.zipCode,
        websiteUrl: business.websiteUrl,
        socialMedia: business.socialMedia,
        subscriptionActive: business.subscriptionActive,
        coverImage: null,
        logoImage: null,
        rating: Math.floor(Math.random() * 5 + 45),
        reviewCount: Math.floor(Math.random() * 200 + 50),
        isDemo: true, // Mark seed data as demo - hidden from non-admin users
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
  // NOTIFICATIONS (In-app)
  // ================================

  async createNotification(data: InsertNotification): Promise<Notification> {
    const [notification] = await db.insert(notifications).values(data).returning();
    return notification;
  }

  async getUserNotifications(userId: string, options?: { limit?: number; unreadOnly?: boolean }): Promise<Notification[]> {
    const whereCondition = options?.unreadOnly
      ? and(eq(notifications.userId, userId), eq(notifications.isRead, false))
      : eq(notifications.userId, userId);
    
    const results = await db
      .select()
      .from(notifications)
      .where(whereCondition)
      .orderBy(desc(notifications.createdAt), asc(notifications.id))
      .limit(options?.limit ?? 100);

    return results;
  }

  async markNotificationRead(id: string, userId: string): Promise<Notification | undefined> {
    const [notification] = await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .returning();
    return notification;
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await db
      .update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  }

  async getUnreadNotificationCount(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return Number(result[0]?.count || 0);
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

  async getVendorSubscriptionByBusinessId(businessId: string): Promise<VendorSubscription | undefined> {
    const [subscription] = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.businessId, businessId));
    return subscription;
  }

  async isBusinessSubscriptionActive(businessId: string, gracePeriodDays: number = 3): Promise<{ active: boolean; status?: string; reason?: string }> {
    const subscription = await this.getVendorSubscriptionByBusinessId(businessId);
    
    if (!subscription) {
      return { active: false, reason: 'No subscription found for this business' };
    }

    return this.checkSubscriptionActiveStatus(subscription, gracePeriodDays);
  }

  async isVendorSubscriptionActive(vendorId: string, gracePeriodDays: number = 3): Promise<{ active: boolean; status?: string; reason?: string }> {
    const subscription = await this.getVendorSubscription(vendorId);
    
    if (!subscription) {
      return { active: false, reason: 'No subscription found' };
    }

    return this.checkSubscriptionActiveStatus(subscription, gracePeriodDays);
  }

  private checkSubscriptionActiveStatus(subscription: VendorSubscription, gracePeriodDays: number): { active: boolean; status?: string; reason?: string } {
    const status = subscription.status ?? undefined;
    
    // Active subscription
    if (status === 'active') {
      return { active: true, status };
    }

    // Trialing is also considered active
    if (status === 'trialing') {
      return { active: true, status };
    }

    // Past due - allow grace period from when status changed (updatedAt)
    if (status === 'past_due') {
      // Use updatedAt as the timestamp when subscription became past_due
      const statusChangeDate = subscription.updatedAt;
      if (statusChangeDate) {
        const gracePeriodEnd = new Date(statusChangeDate);
        gracePeriodEnd.setDate(gracePeriodEnd.getDate() + gracePeriodDays);
        
        if (new Date() <= gracePeriodEnd) {
          return { active: true, status, reason: 'Payment past due - grace period active' };
        }
      }
      return { active: false, status, reason: 'Subscription payment failed and grace period expired' };
    }

    // Cancelled but still in period
    if (status === 'canceled') {
      const periodEnd = subscription.currentPeriodEnd;
      if (periodEnd && new Date() <= periodEnd) {
        return { active: true, status, reason: 'Subscription cancelled - active until period end' };
      }
      return { active: false, status, reason: 'Subscription has been cancelled' };
    }

    // Pending subscription (just created, not yet activated via Stripe)
    if (status === 'pending') {
      return { active: false, status, reason: 'Subscription pending activation' };
    }

    // Other statuses (incomplete, incomplete_expired, unpaid, paused)
    return { active: false, status, reason: `Subscription is ${status}` };
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
        monthlyAllowance: benefit.includedQuantity ?? 0,
        periodStart: cycleStart,
        periodEnd: cycleEnd,
        cycleStart,
        cycleEnd,
        usedQuantity: 0,
        remainingQuantity: benefit.includedQuantity ?? 0,
        isUnlimited: benefit.isUnlimited ?? false,
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
            monthlyAllowance: benefit.includedQuantity ?? 0,
            periodStart: cycleStart,
            periodEnd: cycleEnd,
            cycleStart,
            cycleEnd,
            usedQuantity: 0,
            remainingQuantity: benefit.includedQuantity ?? 0,
            isUnlimited: benefit.isUnlimited ?? false,
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

    if ((allowance.remainingQuantity ?? 0) <= 0) {
      return { success: false, error: 'No remaining uses for this benefit' };
    }

    const now = new Date();
    if (allowance.cycleEnd && now > allowance.cycleEnd) {
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
        usedQuantity: (allowance.usedQuantity ?? 0) + 1,
        remainingQuantity: (allowance.remainingQuantity ?? 0) - 1,
      })
      .where(eq(benefitAllowances.id, allowanceId))
      .returning();

    await db.insert(benefitUsage).values({
      allowanceId,
      vendorId,
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
        taskName: benefit.benefitName,
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

  async migrateBenefitsForTierChange(
    subscriptionId: string, 
    previousTierId: string, 
    newTierId: string
  ): Promise<void> {
    const now = new Date();

    // Get the subscription to find cycle dates
    const [subscription] = await db.select()
      .from(vendorSubscriptions)
      .where(eq(vendorSubscriptions.id, subscriptionId));
    
    if (!subscription) {
      console.error(`Cannot migrate benefits: subscription ${subscriptionId} not found`);
      return;
    }

    // Expire all current allowances for the old tier
    await db.update(benefitAllowances)
      .set({ 
        isExpired: true, 
        expiredAt: now 
      })
      .where(and(
        eq(benefitAllowances.subscriptionId, subscriptionId),
        eq(benefitAllowances.isExpired, false)
      ));

    // Create new allowances for the new tier using current cycle dates
    const periodStart = subscription.currentPeriodStart || now;
    const periodEnd = subscription.currentPeriodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const quarterStart = subscription.currentQuarterStart || this.getQuarterStart(periodStart);
    const quarterEnd = subscription.currentQuarterEnd || this.getQuarterEnd(periodStart);

    await this.createBenefitAllowances(subscriptionId, {
      periodStart,
      periodEnd,
      quarterStart,
      quarterEnd,
    });

    console.log(`Migrated benefits for subscription ${subscriptionId}: ${previousTierId} -> ${newTierId}`);
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
      priceInCents: data.finalPriceInCents,
      platformFeeInCents: data.platformFeeInCents,
      stripeCheckoutSessionId: data.stripeCheckoutSessionId,
      status: 'pending',
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
    const insertData: Parameters<typeof db.insert<typeof vendorProducts>>["0"]["$inferInsert"] = {
      businessId: data.businessId,
      name: data.name,
      description: data.description ?? undefined,
      price: data.price,
      compareAtPrice: data.compareAtPrice ?? undefined,
      category: data.category ?? undefined,
      imageUrl: data.imageUrl ?? undefined,
      images: data.images ? [...data.images] : undefined,
      isActive: data.isActive ?? undefined,
      isFeatured: data.isFeatured ?? undefined,
      status: data.status ?? undefined,
      inventory: data.inventory ?? undefined,
      trackInventory: data.trackInventory ?? undefined,
      tags: data.tags ?? undefined,
      stripeProductId: data.stripeProductId ?? undefined,
      stripePriceId: data.stripePriceId ?? undefined,
    };
    const [product] = await db.insert(vendorProducts).values(insertData).returning();
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

  async getServices(): Promise<VendorService[]> {
    return db.select().from(vendorServices);
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

  async updateAllVendorServicesCancellationPolicy(
    businessId: string,
    excludeServiceId: string,
    policy: {
      fullRefundWindow: string | null;
      hasPartialRefund: boolean;
      partialRefundWindow: string | null;
      partialRefundPercentage: number | null;
      hasCancellationFee: boolean;
      cancellationFeeType: string | null;
      cancellationFeeAmount: number | null;
    },
  ): Promise<number> {
    const result = await db.update(vendorServices)
      .set(policy)
      .where(and(
        eq(vendorServices.businessId, businessId),
        ne(vendorServices.id, excludeServiceId),
      ))
      .returning({ id: vendorServices.id });
    return result.length;
  }

  // =========================
  // SUBSCRIPTION ENFORCEMENT - PAUSE/UNPAUSE ITEMS
  // =========================

  async pauseBusinessLiveItems(businessId: string): Promise<{ pausedProducts: number; pausedServices: number }> {
    // Pause all live products for this business
    const productResult = await db.update(vendorProducts)
      .set({ status: 'paused' })
      .where(and(
        eq(vendorProducts.businessId, businessId),
        eq(vendorProducts.status, 'live')
      ))
      .returning();

    // Pause all live services for this business
    const serviceResult = await db.update(vendorServices)
      .set({ status: 'paused' })
      .where(and(
        eq(vendorServices.businessId, businessId),
        eq(vendorServices.status, 'live')
      ))
      .returning();

    return {
      pausedProducts: productResult.length,
      pausedServices: serviceResult.length,
    };
  }

  async unpauseBusinessPausedItems(businessId: string): Promise<{ unpausedProducts: number; unpausedServices: number }> {
    // Unpause all paused products for this business (restore to live)
    const productResult = await db.update(vendorProducts)
      .set({ status: 'live' })
      .where(and(
        eq(vendorProducts.businessId, businessId),
        eq(vendorProducts.status, 'paused')
      ))
      .returning();

    // Unpause all paused services for this business (restore to live)
    const serviceResult = await db.update(vendorServices)
      .set({ status: 'live' })
      .where(and(
        eq(vendorServices.businessId, businessId),
        eq(vendorServices.status, 'paused')
      ))
      .returning();

    return {
      unpausedProducts: productResult.length,
      unpausedServices: serviceResult.length,
    };
  }

  // =========================
  // BUSINESS AVAILABILITY CALENDAR
  // =========================

  async getBusinessAvailability(businessId: string, startDate?: string, endDate?: string): Promise<BusinessAvailability[]> {
    let query = db.select()
      .from(businessAvailability)
      .where(eq(businessAvailability.businessId, businessId));
    
    if (startDate && endDate) {
      query = db.select()
        .from(businessAvailability)
        .where(and(
          eq(businessAvailability.businessId, businessId),
          sql`${businessAvailability.date} >= ${startDate}`,
          sql`${businessAvailability.date} <= ${endDate}`
        ));
    }
    
    return query;
  }

  async getBusinessAvailabilitySlot(id: string): Promise<BusinessAvailability | undefined> {
    const [slot] = await db.select()
      .from(businessAvailability)
      .where(eq(businessAvailability.id, id));
    return slot;
  }

  async createBusinessAvailability(data: InsertBusinessAvailability): Promise<BusinessAvailability> {
    const id = randomUUID();
    const [slot] = await db.insert(businessAvailability)
      .values({ id, ...data })
      .returning();
    return slot;
  }

  async updateBusinessAvailability(id: string, updates: Partial<BusinessAvailability>): Promise<BusinessAvailability | undefined> {
    const [slot] = await db.update(businessAvailability)
      .set(updates)
      .where(eq(businessAvailability.id, id))
      .returning();
    return slot;
  }

  async deleteBusinessAvailability(id: string): Promise<void> {
    await db.delete(businessAvailability).where(eq(businessAvailability.id, id));
  }

  async checkBusinessSlotAvailable(businessId: string, date: string, startTime: string, endTime: string, excludeSlotId?: string): Promise<boolean> {
    // Check for overlapping booked or blocked slots in availability table
    const overlappingSlots = await db.select()
      .from(businessAvailability)
      .where(and(
        eq(businessAvailability.businessId, businessId),
        eq(businessAvailability.date, date),
        or(
          eq(businessAvailability.slotType, 'booked'),
          eq(businessAvailability.slotType, 'blocked')
        ),
        // Time overlap check: new slot starts before existing ends AND new slot ends after existing starts
        sql`${businessAvailability.startTime} < ${endTime}`,
        sql`${businessAvailability.endTime} > ${startTime}`,
        excludeSlotId ? sql`${businessAvailability.id} != ${excludeSlotId}` : sql`1=1`
      ));
    
    if (overlappingSlots.length > 0) return false;

    // Also check for existing appointments (legacy data without availability slots)
    const overlappingAppointments = await db.select()
      .from(appointments)
      .where(and(
        eq(appointments.businessId, businessId),
        eq(appointments.appointmentDate, date),
        sql`${appointments.status} NOT IN ('cancelled', 'refunded')`,
        sql`${appointments.appointmentTime} < ${endTime}`,
        sql`${appointments.appointmentTime} >= ${startTime}`
      ));

    return overlappingAppointments.length === 0;
  }

  async reserveBusinessSlot(businessId: string, date: string, startTime: string, endTime: string, appointmentId: string): Promise<BusinessAvailability> {
    const id = randomUUID();
    const [slot] = await db.insert(businessAvailability)
      .values({
        id,
        businessId,
        date,
        startTime,
        endTime,
        slotType: 'booked',
        appointmentId,
        title: 'Booked Appointment',
      })
      .returning();
    return slot;
  }

  // Release a business slot when appointment is cancelled/refunded
  async releaseBusinessSlot(appointmentId: string): Promise<boolean> {
    const result = await db.delete(businessAvailability)
      .where(eq(businessAvailability.appointmentId, appointmentId))
      .returning();
    return result.length > 0;
  }

  // =========================
  // PHOTOGRAPHER AVAILABILITY
  // =========================

  async getPhotographerAvailability(photographerId: string, startDate?: string, endDate?: string): Promise<PhotographerAvailability[]> {
    let query = db.select()
      .from(photographerAvailability)
      .where(eq(photographerAvailability.photographerId, photographerId));
    
    if (startDate && endDate) {
      query = db.select()
        .from(photographerAvailability)
        .where(and(
          eq(photographerAvailability.photographerId, photographerId),
          sql`${photographerAvailability.date} >= ${startDate}`,
          sql`${photographerAvailability.date} <= ${endDate}`
        ));
    }
    
    return query;
  }

  async getPhotographerAvailabilitySlot(id: string): Promise<PhotographerAvailability | undefined> {
    const [slot] = await db.select()
      .from(photographerAvailability)
      .where(eq(photographerAvailability.id, id));
    return slot;
  }

  async createPhotographerAvailability(data: InsertPhotographerAvailability): Promise<PhotographerAvailability> {
    const id = randomUUID();
    const [slot] = await db.insert(photographerAvailability)
      .values({ id, ...data })
      .returning();
    return slot;
  }

  async updatePhotographerAvailability(id: string, updates: Partial<PhotographerAvailability>): Promise<PhotographerAvailability | undefined> {
    const [slot] = await db.update(photographerAvailability)
      .set(updates)
      .where(eq(photographerAvailability.id, id))
      .returning();
    return slot;
  }

  async deletePhotographerAvailability(id: string): Promise<void> {
    await db.delete(photographerAvailability).where(eq(photographerAvailability.id, id));
  }

  async checkPhotographerSlotAvailable(photographerId: string, date: string, startTime: string, endTime: string, excludeSlotId?: string): Promise<boolean> {
    // Check for overlapping booked or blocked slots in availability table
    const overlappingSlots = await db.select()
      .from(photographerAvailability)
      .where(and(
        eq(photographerAvailability.photographerId, photographerId),
        eq(photographerAvailability.date, date),
        or(
          eq(photographerAvailability.slotType, 'booked'),
          eq(photographerAvailability.slotType, 'blocked')
        ),
        // Time overlap check
        sql`${photographerAvailability.startTime} < ${endTime}`,
        sql`${photographerAvailability.endTime} > ${startTime}`,
        excludeSlotId ? sql`${photographerAvailability.id} != ${excludeSlotId}` : sql`1=1`
      ));
    
    if (overlappingSlots.length > 0) return false;

    // Also check for existing shoot bookings (legacy data without availability slots)
    const overlappingBookings = await db.select()
      .from(shootBookings)
      .where(and(
        eq(shootBookings.photographerId, photographerId),
        eq(shootBookings.date, date),
        sql`${shootBookings.status} NOT IN ('cancelled', 'refunded')`,
        sql`${shootBookings.startTime} < ${endTime}`,
        sql`${shootBookings.endTime} > ${startTime}`
      ));

    return overlappingBookings.length === 0;
  }

  async reservePhotographerSlot(photographerId: string, date: string, startTime: string, endTime: string, shootBookingId: string): Promise<PhotographerAvailability> {
    const id = randomUUID();
    const [slot] = await db.insert(photographerAvailability)
      .values({
        id,
        photographerId,
        date,
        startTime,
        endTime,
        slotType: 'booked',
        shootBookingId,
        title: 'Booked Shoot',
      })
      .returning();
    return slot;
  }

  // Release a photographer slot when shoot booking is cancelled/refunded
  async releasePhotographerSlot(shootBookingId: string): Promise<boolean> {
    const result = await db.delete(photographerAvailability)
      .where(eq(photographerAvailability.shootBookingId, shootBookingId))
      .returning();
    return result.length > 0;
  }

  // =========================
  // STAFF MEMBERS
  // =========================

  async createStaffMember(data: InsertStaffMember): Promise<StaffMember> {
    const insertData: typeof staffMembers.$inferInsert = {
      businessId: data.businessId,
      displayName: data.displayName,
      userId: data.userId ?? undefined,
      bio: data.bio ?? undefined,
      profileImageUrl: data.profileImageUrl ?? undefined,
      phone: data.phone ?? undefined,
      email: data.email ?? undefined,
      serviceIds: data.serviceIds ? [...data.serviceIds] : undefined,
      specialties: data.specialties ?? undefined,
      role: data.role ?? undefined,
      status: data.status ?? undefined,
      stripeAccountId: data.stripeAccountId ?? undefined,
      stripeOnboardingComplete: data.stripeOnboardingComplete ?? undefined,
      stripeOnboardingUrl: data.stripeOnboardingUrl ?? undefined,
      hoursOfOperation: (data.hoursOfOperation as HoursOfOperation) ?? undefined,
    };
    const [staff] = await db.insert(staffMembers)
      .values(insertData)
      .returning();
    return staff;
  }

  async getStaffMember(id: string): Promise<(StaffMember & { username: string | null }) | undefined> {
    const result = await db
      .select({ staff: staffMembers, linkedUsername: users.username })
      .from(staffMembers)
      .leftJoin(users, eq(staffMembers.userId, users.id))
      .where(eq(staffMembers.id, id));
    const row = result[0];
    if (!row) return undefined;
    return { ...row.staff, username: row.linkedUsername ?? null };
  }

  // Ambiguous when a person is staff at 2+ businesses (no business filter, no
  // deterministic order) — self-service routes must use the business-scoped
  // lookups below instead. Kept only because it's part of the public interface.
  async getStaffMemberByUserId(userId: string): Promise<StaffMember | undefined> {
    const result = await db.select().from(staffMembers).where(eq(staffMembers.userId, userId));
    return result[0];
  }

  async getStaffMembersByUserId(userId: string): Promise<StaffMember[]> {
    return db.select().from(staffMembers).where(eq(staffMembers.userId, userId));
  }

  async getStaffMemberByUserIdAndBusiness(userId: string, businessId: string): Promise<StaffMember | undefined> {
    const result = await db.select().from(staffMembers)
      .where(and(eq(staffMembers.userId, userId), eq(staffMembers.businessId, businessId)));
    return result[0];
  }

  async findStaffMemberForReactivation(
    businessId: string,
    userId: string | undefined | null,
    email: string | undefined | null,
  ): Promise<StaffMember | undefined> {
    const identityMatch = or(
      userId ? eq(staffMembers.userId, userId) : undefined,
      email ? eq(staffMembers.email, email) : undefined,
    );
    if (!identityMatch) return undefined;
    const result = await db.select().from(staffMembers)
      .where(and(eq(staffMembers.businessId, businessId), identityMatch));
    return result[0];
  }

  async touchStaffMemberLastActive(staffId: string): Promise<void> {
    await db.update(staffMembers)
      .set({ lastActiveAt: new Date() })
      .where(eq(staffMembers.id, staffId));
  }

  async getStaffMemberByStripeAccountId(stripeAccountId: string): Promise<StaffMember | undefined> {
    const result = await db.select().from(staffMembers).where(eq(staffMembers.stripeAccountId, stripeAccountId));
    return result[0];
  }

  async getStaffMembersByBusiness(businessId: string): Promise<(StaffMember & { username: string | null })[]> {
    const result = await db
      .select({ staff: staffMembers, linkedUsername: users.username })
      .from(staffMembers)
      .leftJoin(users, eq(staffMembers.userId, users.id))
      .where(eq(staffMembers.businessId, businessId))
      .orderBy(staffMembers.displayName);
    return result.map((row) => ({ ...row.staff, username: row.linkedUsername ?? null }));
  }

  async getActiveStaffCount(businessId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(staffMembers)
      .where(and(eq(staffMembers.businessId, businessId), eq(staffMembers.status, 'active')));
    return result[0]?.count || 0;
  }

  async updateStaffMember(id: string, updates: Partial<StaffMember>): Promise<StaffMember | undefined> {
    const [updated] = await db.update(staffMembers)
      .set(updates)
      .where(eq(staffMembers.id, id))
      .returning();
    return updated;
  }

  async deleteStaffMember(id: string): Promise<void> {
    await db.delete(staffMembers).where(eq(staffMembers.id, id));
  }

  // =========================
  // STAFF AVAILABILITY
  // =========================

  async getStaffAvailability(staffMemberId: string, startDate?: string, endDate?: string): Promise<StaffAvailability[]> {
    if (startDate && endDate) {
      return db.select()
        .from(staffAvailability)
        .where(
          and(
            eq(staffAvailability.staffMemberId, staffMemberId),
            gte(staffAvailability.date, startDate),
            lte(staffAvailability.date, endDate)
          )
        )
        .orderBy(staffAvailability.date, staffAvailability.startTime);
    }
    
    return db.select()
      .from(staffAvailability)
      .where(eq(staffAvailability.staffMemberId, staffMemberId))
      .orderBy(staffAvailability.date, staffAvailability.startTime);
  }

  async getStaffAvailabilitySlot(id: string): Promise<StaffAvailability | undefined> {
    const result = await db.select().from(staffAvailability).where(eq(staffAvailability.id, id));
    return result[0];
  }

  async createStaffAvailability(data: InsertStaffAvailability): Promise<StaffAvailability> {
    const id = randomUUID();
    const [slot] = await db.insert(staffAvailability)
      .values({ id, ...data })
      .returning();
    return slot;
  }

  async updateStaffAvailability(id: string, updates: Partial<StaffAvailability>): Promise<StaffAvailability | undefined> {
    const [updated] = await db.update(staffAvailability)
      .set(updates)
      .where(eq(staffAvailability.id, id))
      .returning();
    return updated;
  }

  async deleteStaffAvailability(id: string): Promise<void> {
    await db.delete(staffAvailability).where(eq(staffAvailability.id, id));
  }

  async releaseStaffSlot(appointmentId: string): Promise<boolean> {
    const result = await db.delete(staffAvailability)
      .where(eq(staffAvailability.appointmentId, appointmentId))
      .returning();
    return result.length > 0;
  }

  // =========================
  // STAFF INVITES
  // =========================

  async createStaffInvite(data: InsertStaffInvite): Promise<StaffInvite> {
    const id = randomUUID();
    const inviteCode = randomUUID().substring(0, 8).toUpperCase();
    const [invite] = await db.insert(staffInvites)
      .values({ id, ...data, inviteCode })
      .returning();
    return invite;
  }

  async getStaffInvite(id: string): Promise<StaffInvite | undefined> {
    const result = await db.select().from(staffInvites).where(eq(staffInvites.id, id));
    return result[0];
  }

  async getStaffInviteByCode(code: string): Promise<StaffInvite | undefined> {
    const result = await db.select().from(staffInvites).where(eq(staffInvites.inviteCode, code));
    return result[0];
  }

  async getStaffInviteWithContext(code: string): Promise<StaffInvitePreview | null> {
    const result = await db
      .select({
        businessName: businesses.name,
        businessLogo: businesses.logoImage,
        businessCategory: businesses.category,
        businessCity: businesses.city,
        businessState: businesses.state,
        role: staffInvites.role,
        inviterFirstName: users.firstName,
        inviterLastName: users.lastName,
        inviterName: users.name,
        expiresAt: staffInvites.expiresAt,
        status: staffInvites.status,
      })
      .from(staffInvites)
      .leftJoin(businesses, eq(staffInvites.businessId, businesses.id))
      .leftJoin(users, eq(staffInvites.invitedByUserId, users.id))
      .where(eq(staffInvites.inviteCode, code));

    if (!result[0]) return null;

    const row = result[0];
    const invitedByName =
      row.inviterFirstName && row.inviterLastName
        ? `${row.inviterFirstName} ${row.inviterLastName}`
        : row.inviterName || null;

    // A pending invite past its expiresAt is effectively dead even though
    // nothing has written status="expired" to the row yet (that happens
    // lazily elsewhere, e.g. on an accept attempt) — never preview it as "pending".
    const isExpired = row.status === "pending" && new Date(row.expiresAt) < new Date();

    return {
      businessName: row.businessName,
      businessLogo: row.businessLogo,
      businessCategory: row.businessCategory,
      businessCity: row.businessCity,
      businessState: row.businessState,
      role: row.role,
      invitedByName,
      expiresAt: row.expiresAt,
      status: isExpired ? "expired" : row.status,
      isExpired,
    };
  }

  async getStaffInvitesByBusiness(businessId: string): Promise<StaffInvite[]> {
    return db.select().from(staffInvites)
      .where(eq(staffInvites.businessId, businessId))
      .orderBy(desc(staffInvites.createdAt));
  }

  async getStaffInvitesByEmail(email: string): Promise<StaffInvite[]> {
    return db.select().from(staffInvites)
      .where(eq(staffInvites.email, email))
      .orderBy(desc(staffInvites.createdAt));
  }

  async updateStaffInvite(id: string, updates: Partial<StaffInvite>): Promise<StaffInvite | undefined> {
    const [updated] = await db.update(staffInvites)
      .set(updates)
      .where(eq(staffInvites.id, id))
      .returning();
    return updated;
  }

  async reactivateStaffInvite(
    id: string,
    data: { phone?: string | null; role?: string; invitedByUserId?: string },
  ): Promise<StaffInvite | undefined> {
    const inviteCode = randomUUID().substring(0, 8).toUpperCase();
    const [updated] = await db.update(staffInvites)
      .set({
        phone: data.phone ?? null,
        role: data.role ?? "staff",
        invitedByUserId: data.invitedByUserId,
        inviteCode,
        status: "pending",
        sentAt: null,
        acceptedAt: null,
        acceptedByUserId: null,
        expiresAt: sql`NOW() + INTERVAL '7 days'`,
      })
      .where(eq(staffInvites.id, id))
      .returning();
    return updated;
  }

  async deleteStaffInvite(id: string): Promise<void> {
    await db.delete(staffInvites).where(eq(staffInvites.id, id));
  }

  // =========================
  // STAFF SERVICES
  // =========================

  async createStaffService(data: InsertStaffService): Promise<StaffService> {
    const id = randomUUID();
    const [service] = await db.insert(staffServices).values({ id, ...data }).returning();
    return service;
  }

  async getStaffService(id: string): Promise<StaffService | undefined> {
    const [service] = await db.select().from(staffServices).where(eq(staffServices.id, id));
    return service;
  }

  async getStaffServicesByStaffMember(staffMemberId: string): Promise<StaffService[]> {
    return db.select().from(staffServices)
      .where(eq(staffServices.staffMemberId, staffMemberId));
  }

  async getLiveStaffServicesByStaffMember(staffMemberId: string): Promise<StaffService[]> {
    return db.select().from(staffServices)
      .where(and(eq(staffServices.staffMemberId, staffMemberId), eq(staffServices.status, 'live')));
  }

  async hasLiveStaffServices(staffMemberId: string): Promise<boolean> {
    const [row] = await db.select({ id: staffServices.id }).from(staffServices)
      .where(and(eq(staffServices.staffMemberId, staffMemberId), eq(staffServices.status, 'live')))
      .limit(1);
    return !!row;
  }

  async updateStaffService(id: string, updates: Partial<StaffService>): Promise<StaffService | undefined> {
    const [service] = await db.update(staffServices).set(updates)
      .where(eq(staffServices.id, id)).returning();
    return service;
  }

  async deleteStaffService(id: string): Promise<void> {
    await db.delete(staffServices).where(eq(staffServices.id, id));
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
        postIntent: data.postIntent || undefined,
        displayLayout: data.displayLayout || undefined,
        feedSurface: data.feedSurface || undefined,
        content: data.content,
        imageUrl: data.imageUrl || undefined,
        mediaUrl: data.mediaUrl || undefined,
        mediaType: data.mediaType || undefined,
        thumbnailUrl: data.thumbnailUrl || undefined,
        mediaWidth: data.mediaWidth || undefined,
        mediaHeight: data.mediaHeight || undefined,
        aspectRatio: data.aspectRatio || undefined,
        taggedBusinessId: data.taggedBusinessId || undefined,
        taggedPhotographerId: data.taggedPhotographerId || undefined,
        productId: data.productId || undefined,
        serviceId: data.serviceId || undefined,
        photographerServiceId: data.photographerServiceId || undefined,
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

  async getAlgorithmicFeed(userId: string | null, limit = 50, offset = 0, city?: string): Promise<FeedPost[]> {
    // Get user preferences if authenticated
    let userPreferences: { 
      selectedIndustries?: string[]; 
      industryNiches?: Record<string, string[]>;
      latitude?: number | null;
      longitude?: number | null;
    } = {};
    
    if (userId) {
      const [user] = await db.select({
        selectedIndustries: users.selectedIndustries,
        industryNiches: users.industryNiches,
        latitude: users.latitude,
        longitude: users.longitude,
      }).from(users).where(eq(users.id, userId));
      if (user) {
        userPreferences = {
          selectedIndustries: user.selectedIndustries ?? undefined,
          industryNiches: user.industryNiches ?? undefined,
          latitude: user.latitude,
          longitude: user.longitude,
        };
      }
    }

    // Build bidirectional block exclusion list for the authenticated user
    let excludedAuthorIds = new Set<string>();
    if (userId) {
      const blockedByMe = await this.getBlockedUsers(userId);
      const blockedMe = await db.select({ blockerId: userBlocks.blockerId })
        .from(userBlocks)
        .where(eq(userBlocks.blockedId, userId));
      for (const b of blockedByMe) excludedAuthorIds.add(b.blockedId);
      for (const b of blockedMe) excludedAuthorIds.add(b.blockerId);
    }

    // Fetch more posts than needed for ranking to ensure we don't miss high-scoring older posts
    // Also fetch posts from last 7 days to balance recency with discovery
    const fetchLimit = Math.max(limit * 5, 500);

    const allPosts = await db.select({
      post: feedPosts,
      business: {
        id: businesses.id,
        category: businesses.category,
        city: businesses.city,
        state: businesses.state,
        latitude: businesses.latitude,
        longitude: businesses.longitude,
      },
      photographer: {
        id: photographers.id,
        city: photographers.city,
        state: photographers.state,
        latitude: photographers.latitude,
        longitude: photographers.longitude,
      },
    })
    .from(feedPosts)
    .leftJoin(businesses, eq(feedPosts.taggedBusinessId, businesses.id))
    .leftJoin(photographers, eq(feedPosts.taggedPhotographerId, photographers.id))
    .where(and(
      eq(feedPosts.isActive, true),
      city ? or(
        ilike(businesses.city, city.trim()),
        ilike(photographers.city, city.trim())
      ) : undefined,
    ))
    .orderBy(sql`${feedPosts.createdAt} DESC`)
    .limit(fetchLimit);

    // Remove posts from blocked/blocking users before scoring
    const visiblePosts = excludedAuthorIds.size > 0
      ? allPosts.filter(({ post }) => !excludedAuthorIds.has(post.authorId))
      : allPosts;

    // Calculate scores for each post
    const scoredPosts = visiblePosts.map(({ post, business, photographer }) => {
      let score = 0;
      const now = Date.now();
      const postAge = now - new Date(post.createdAt).getTime();
      const hoursOld = postAge / (1000 * 60 * 60);

      // Recency score (newer posts get higher base score, decays over 72 hours)
      const recencyScore = Math.max(0, 100 - (hoursOld / 72) * 50);
      score += recencyScore;

      // Engagement score (likes + comments weighted)
      const engagementScore = (post.likesCount || 0) * 2 + (post.commentsCount || 0) * 5;
      score += Math.min(engagementScore, 50); // Cap at 50 points

      // Vendor posts (product/service) get a boost
      if (post.postType === 'product' || post.postType === 'service') {
        score += 15;
      }

      // Category/industry preference matching
      if (userId && userPreferences.selectedIndustries?.length) {
        if (business?.category && userPreferences.selectedIndustries.includes(business.category)) {
          score += 30; // Strong boost for matching industry
        }
      }

      // Location proximity boost (if user has location and post is from nearby)
      // Use explicit null checks to handle coordinates at 0 latitude/longitude
      if (userPreferences.latitude != null && userPreferences.longitude != null) {
        const vendorLat = business?.latitude ?? photographer?.latitude;
        const vendorLng = business?.longitude ?? photographer?.longitude;
        
        if (vendorLat != null && vendorLng != null) {
          const distance = this.calculateDistance(
            userPreferences.latitude, 
            userPreferences.longitude,
            vendorLat,
            vendorLng
          );
          // Boost nearby posts (within 50 miles gets max boost)
          if (distance <= 10) score += 40;
          else if (distance <= 25) score += 25;
          else if (distance <= 50) score += 15;
          else if (distance <= 100) score += 5;
        }
      }

      return { post, score };
    });

    // Sort by score descending, then by recency for ties
    scoredPosts.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime();
    });

    // Apply pagination and return posts only
    return scoredPosts
      .slice(offset, offset + limit)
      .map(sp => sp.post);
  }

  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    // Haversine formula to calculate distance in miles
    const R = 3959; // Earth's radius in miles
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
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

  async getUserFeedPostsByIntent(authorId: string, postIntent: 'social' | 'promotion', limit = 5): Promise<FeedPost[]> {
    return db.select()
      .from(feedPosts)
      .where(and(
        eq(feedPosts.authorId, authorId),
        eq(feedPosts.postIntent, postIntent),
        eq(feedPosts.isActive, true)
      ))
      .orderBy(sql`${feedPosts.createdAt} DESC`)
      .limit(limit);
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

  async updateFeedPostContent(id: string, content: string): Promise<FeedPost | undefined> {
    const [post] = await db.update(feedPosts)
      .set({ content, updatedAt: new Date() })
      .where(eq(feedPosts.id, id))
      .returning();
    return post;
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

  async savePost(postId: string, userId: string): Promise<boolean> {
    const existing = await db.select()
      .from(userSavedPosts)
      .where(and(
        eq(userSavedPosts.postId, postId),
        eq(userSavedPosts.userId, userId)
      ));

    if (existing.length > 0) return true;

    await db.insert(userSavedPosts)
      .values({
        id: randomUUID(),
        postId,
        userId,
      });

    return true;
  }

  async unsavePost(postId: string, userId: string): Promise<boolean> {
    await db.delete(userSavedPosts)
      .where(and(
        eq(userSavedPosts.postId, postId),
        eq(userSavedPosts.userId, userId)
      ));

    return true;
  }

  async getSavedPosts(userId: string): Promise<any[]> {
    const posts = await db
      .select({
        id: feedPosts.id,
        userId: feedPosts.authorId,
        mediaUrl: feedPosts.mediaUrl,
        imageUrl: feedPosts.imageUrl,
        thumbnailUrl: feedPosts.thumbnailUrl,
        caption: feedPosts.content,
        mediaType: feedPosts.mediaType,
        displayLayout: feedPosts.displayLayout,
        feedSurface: feedPosts.feedSurface,
        createdAt: feedPosts.createdAt,
        aspectRatio: feedPosts.aspectRatio,
        likesCount: feedPosts.likesCount,
        commentsCount: feedPosts.commentsCount,
        productId: feedPosts.productId,
        serviceId: feedPosts.serviceId,
        photographerServiceId: feedPosts.photographerServiceId,
      })
      .from(userSavedPosts)
      .innerJoin(feedPosts, eq(userSavedPosts.postId, feedPosts.id))
      .where(and(
        eq(userSavedPosts.userId, userId),
        eq(feedPosts.isActive, true)
      ))
      .orderBy(desc(userSavedPosts.createdAt));

    return posts;
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

  async getLikedPostIds(userId: string, postIds: string[]): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const rows = await db
      .select({ postId: postLikes.postId })
      .from(postLikes)
      .where(and(
        eq(postLikes.userId, userId),
        inArray(postLikes.postId, postIds)
      ));
    return new Set(rows.map(r => r.postId));
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
        eq(appointments.clientId, customerId),
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

  async getProfileComments(targetType: string, targetId: string): Promise<(ProfileComment & { authorName: string | null; authorUsername: string | null; authorImage: string | null })[]> {
    const result = await db.select({
      id: profileComments.id,
      targetType: profileComments.targetType,
      targetId: profileComments.targetId,
      userId: profileComments.userId,
      content: profileComments.content,
      createdAt: profileComments.createdAt,
      authorName: users.name,
      authorUsername: users.username,
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

    // Search photographers with similar filters (only public visibility)
    let photographerResults = await db.select().from(photographers).where(
      eq(photographers.visibilityStatus, 'public')
    );
    
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

  private async getPersonalizationBoosts(viewerUserId: string): Promise<{
    interestVector: Record<string, number>;
    followedSet: Set<string>;
    reviewedTargetIds: Set<string>;
  }> {
    const [interestRows, followRows, reviewRows] = await Promise.all([
      db.select().from(userInterests).where(eq(userInterests.userId, viewerUserId)).limit(1),
      db.select({ targetId: follows.targetUserId }).from(follows).where(eq(follows.followerUserId, viewerUserId)),
      db.select({ targetId: reviews.targetId }).from(reviews).where(eq(reviews.reviewerId, viewerUserId)),
    ]);

    const interestVector = (interestRows[0]?.interestVector as Record<string, number>) || {};
    const followedSet = new Set(followRows.map(f => f.targetId));
    const reviewedTargetIds = new Set(reviewRows.map(r => r.targetId));

    return { interestVector, followedSet, reviewedTargetIds };
  }

  private applyPersonalizationScore(
    result: UnifiedSearchResult,
    boosts: { interestVector: Record<string, number>; followedSet: Set<string>; reviewedTargetIds: Set<string> }
  ): number {
    let score = result.personalizationScore ?? result.baseScore;

    // +50 if viewer follows this entity's user
    if (
      (result.providerUserId && boosts.followedSet.has(result.providerUserId)) ||
      boosts.followedSet.has(result.id)
    ) {
      score += 50;
    }

    // Boost by interest vector weight for this result's category
    const categoryWeight = result.category ? (boosts.interestVector[result.category.toLowerCase()] || 0) : 0;
    score += categoryWeight * 10;

    // +10 if the entity itself was previously reviewed by the viewer (strongest signal)
    if (boosts.reviewedTargetIds.has(result.id)) {
      score += 10;
    }

    return score;
  }

  async unifiedSearchWithScope(params: UnifiedSearchParams): Promise<UnifiedSearchResponse> {
    const { q, scope, viewerUserId, city, personalized, limit, offset, isAdmin } = params;
    const searchTerm = q?.trim() || '';
    const likePattern = searchTerm ? `%${searchTerm}%` : '%';

    let viewerIndustries: string[] = [];
    let viewerNiches: Record<string, string[]> = {};
    if (personalized && viewerUserId) {
      const viewer = await this.getUser(viewerUserId);
      viewerIndustries = viewer?.selectedIndustries || [];
      viewerNiches = viewer?.industryNiches || {};
    }

    const results: UnifiedSearchResult[] = [];

    // ==================== CONSUMERS ====================
    if (scope === 'all' || scope === 'consumers') {
      // Exclude users who are active, fully-onboarded staff members elsewhere
      // in the app (mirrors the STAFF block's own gating below) so the same
      // person doesn't surface as both "consumer" and "staff" in results.
      const activeStaffUserIds = db
        .select({ userId: staffMembers.userId })
        .from(staffMembers)
        .where(
          and(
            isNotNull(staffMembers.userId),
            eq(staffMembers.status, 'active'),
            eq(staffMembers.stripeOnboardingComplete, true)
          )
        );

      const consumerRows = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.isVendor, false),
            eq(users.isPhotographer, false),
            isAdmin ? undefined : eq(users.isActive, true),
            notInArray(users.id, activeStaffUserIds),
            or(
              ilike(users.username, likePattern),
              ilike(users.name, likePattern),
              ilike(users.firstName, likePattern),
              ilike(users.lastName, likePattern)
            ),
            city ? ilike(users.city, `%${city}%`) : undefined
          )
        )
        .limit(scope === 'all' ? 15 : limit)
        .offset(scope === 'consumers' ? offset : 0);

      for (const u of consumerRows) {
        if (!isAdmin && u.isAdmin) continue;
        const displayName =
          u.name ||
          (u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : null) ||
          u.username ||
          'Unknown';

        let baseScore = 0;
        if (searchTerm) {
          const lower = searchTerm.toLowerCase();
          const nameLower = displayName.toLowerCase();
          const userLower = (u.username || '').toLowerCase();
          if (nameLower === lower || userLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower) || userLower.startsWith(lower)) baseScore = 75;
          else baseScore = 40;
        } else {
          baseScore = 20;
        }

        results.push({
          id: u.id,
          type: 'consumer',
          title: displayName,
          subtitle: [u.city, u.state].filter(Boolean).join(', ') || null,
          imageUrl: u.profileImageUrl || null,
          ratingAvg: null,
          ratingCount: null,
          category: null,
          providerUserId: u.id,
          username: u.username || null,
          baseScore,
          personalizationScore: baseScore,
        });
      }
    }

    // ==================== PHOTOGRAPHERS ====================
    if (scope === 'all' || scope === 'photographers') {
      const photogs = await db
        .select()
        .from(photographers)
        .where(
          and(
            or(
              ilike(photographers.displayName, likePattern),
              ilike(photographers.bio, likePattern),
              sql`${photographers.specialties}::text ILIKE ${likePattern}`
            ),
            city ? ilike(photographers.city, `%${city}%`) : undefined,
            isAdmin ? undefined : eq(photographers.visibilityStatus, 'public')
          )
        )
        .limit(scope === 'all' ? 15 : limit)
        .offset(scope === 'photographers' ? offset : 0);

      for (const p of photogs) {
        const lower = searchTerm.toLowerCase();
        const nameLower = (p.displayName || '').toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 80;
          else baseScore = 45;
        } else {
          baseScore = 30 + (p.rating || 0) * 2;
        }

        let personalizationScore = baseScore;
        if (personalized) {
          const specialties = p.specialties || [];
          const nicheMatch = specialties.some((s: string) =>
            viewerIndustries.some(ind => s.toLowerCase().includes(ind.toLowerCase()))
          );
          if (nicheMatch) personalizationScore += 25;
        }

        results.push({
          id: p.id,
          type: 'photographer',
          title: p.displayName || 'Photographer',
          subtitle: [p.city, p.state].filter(Boolean).join(', ') || null,
          imageUrl: p.logoImage || p.coverImage || null,
          ratingAvg: p.rating ? p.rating / 10 : null,
          ratingCount: p.reviewCount || null,
          category: (p.specialties || [])[0] || 'Photography',
          providerUserId: p.userId,
          username: null,
          baseScore,
          personalizationScore,
        });
      }
    }

    // ==================== BUSINESSES ====================
    if (scope === 'all' || scope === 'businesses') {
      const businessRows = await db
        .select()
        .from(businesses)
        .where(
          and(
            or(
              ilike(businesses.name, likePattern),
              ilike(businesses.category, likePattern),
              ilike(businesses.description, likePattern),
              ilike(businesses.tagline, likePattern)
            ),
            city ? ilike(businesses.city, `%${city}%`) : undefined,
            isAdmin ? undefined : eq(businesses.approvalStatus, 'approved')
          )
        )
        .limit(scope === 'all' ? 15 : limit)
        .offset(scope === 'businesses' ? offset : 0);

      for (const b of businessRows) {
        if (!isAdmin && b.ownerId?.toLowerCase().includes('demo')) continue;

        if (!isAdmin) {
          const subStatus = await this.isBusinessSubscriptionActive(b.id);
          if (!subStatus.active) continue;
        }

        const lower = searchTerm.toLowerCase();
        const nameLower = b.name.toLowerCase();
        const catLower = (b.category || '').toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 85;
          else if (catLower.includes(lower)) baseScore = 60;
          else baseScore = 40;
        } else {
          baseScore = 30 + (b.rating || 0) * 2;
        }

        let personalizationScore = baseScore;
        if (personalized) {
          const catMatch = viewerIndustries.some(ind =>
            (b.category || '').toLowerCase().includes(ind.toLowerCase())
          );
          if (catMatch) personalizationScore += 30;

          const nicheValues = Object.values(viewerNiches).flat();
          const nicheMatch = nicheValues.some(n =>
            (b.category || '').toLowerCase().includes(n.toLowerCase()) ||
            (b.description || '').toLowerCase().includes(n.toLowerCase())
          );
          if (nicheMatch) personalizationScore += 15;
        }

        results.push({
          id: b.id,
          type: 'business',
          title: b.name,
          subtitle: [b.category, [b.city, b.state].filter(Boolean).join(', ')]
            .filter(Boolean)
            .join(' · ') || null,
          imageUrl: b.logoImage || b.coverImage || null,
          ratingAvg: b.rating ? b.rating / 10 : null,
          ratingCount: b.reviewCount || null,
          category: b.category || null,
          providerUserId: b.ownerId,
          username: null,
          baseScore,
          personalizationScore,
        });
      }
    }

    // ==================== STAFF ====================
    if (scope === 'all' || scope === 'staff') {
      const staffRows = await db
        .select({
          st: staffMembers,
          bName: businesses.name,
          bCity: businesses.city,
          bState: businesses.state,
          linkedUsername: users.username,
        })
        .from(staffMembers)
        .innerJoin(businesses, eq(staffMembers.businessId, businesses.id))
        .leftJoin(users, eq(staffMembers.userId, users.id))
        .where(
          and(
            eq(staffMembers.status, 'active'),
            eq(staffMembers.stripeOnboardingComplete, true),
            or(
              ilike(staffMembers.displayName, likePattern),
              sql`${staffMembers.specialties}::text ILIKE ${likePattern}`
            ),
            city ? ilike(businesses.city, `%${city}%`) : undefined
          )
        )
        .limit(scope === 'all' ? 15 : limit)
        .offset(scope === 'staff' ? offset : 0);

      for (const row of staffRows) {
        const lower = searchTerm.toLowerCase();
        const nameLower = (row.st.displayName || '').toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 80;
          else baseScore = 45;
        } else {
          baseScore = 25;
        }

        let personalizationScore = baseScore;
        if (personalized) {
          const specialties = row.st.specialties || [];
          const nicheMatch = specialties.some((s: string) =>
            viewerIndustries.some(ind => s.toLowerCase().includes(ind.toLowerCase()))
          );
          if (nicheMatch) personalizationScore += 25;
        }

        results.push({
          id: row.st.id,
          type: 'staff',
          title: row.st.displayName,
          subtitle: row.bName
            ? `@ ${row.bName}${row.bCity ? ` · ${row.bCity}` : ''}`
            : null,
          imageUrl: row.st.profileImageUrl || null,
          ratingAvg: row.st.rating || null,
          ratingCount: row.st.reviewCount || null,
          category: (row.st.specialties || [])[0] || null,
          providerUserId: row.st.userId || null,
          username: row.linkedUsername || null,
          businessId: row.st.businessId,
          businessName: row.bName || null,
          baseScore,
          personalizationScore,
        });
      }
    }

    // ==================== PRODUCTS ====================
    if (scope === 'all' || scope === 'products') {
      const productRows = await db
        .select({
          p: vendorProducts,
          bName: businesses.name,
          bCity: businesses.city,
          bState: businesses.state,
          bOwnerId: businesses.ownerId,
          bStripe: businesses.stripeOnboardingComplete,
          bApproval: businesses.approvalStatus,
          isFeatured: vendorProducts.isFeatured,
        })
        .from(vendorProducts)
        .innerJoin(businesses, eq(vendorProducts.businessId, businesses.id))
        .where(
          and(
            eq(vendorProducts.status, 'live'),
            eq(vendorProducts.isActive, true),
            or(
              ilike(vendorProducts.name, likePattern),
              ilike(vendorProducts.description, likePattern),
              ilike(vendorProducts.category, likePattern)
            ),
            city ? ilike(businesses.city, `%${city}%`) : undefined,
            isAdmin ? undefined : eq(businesses.approvalStatus, 'approved'),
            isAdmin ? undefined : eq(businesses.stripeOnboardingComplete, true)
          )
        )
        .limit(scope === 'all' ? 10 : limit)
        .offset(scope === 'products' ? offset : 0);

      for (const row of productRows) {
        if (!isAdmin && row.bOwnerId?.toLowerCase().includes('demo')) continue;

        const lower = searchTerm.toLowerCase();
        const nameLower = row.p.name.toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 80;
          else baseScore = 45;
        } else {
          baseScore = 25;
        }

        let personalizationScore = baseScore;
        if (personalized) {
          const catMatch = viewerIndustries.some(ind =>
            (row.p.category || '').toLowerCase().includes(ind.toLowerCase())
          );
          if (catMatch) personalizationScore += 20;
        }

        results.push({
          id: row.p.id,
          type: 'product',
          title: row.p.name,
          subtitle: row.bName
            ? `${row.bName}${row.bCity ? ` · ${row.bCity}` : ''}`
            : null,
          imageUrl: row.p.imageUrl || null,
          ratingAvg: null,
          ratingCount: null,
          category: row.p.category || null,
          providerUserId: row.bOwnerId || null,
          username: null,
          price: row.p.price,
          businessId: row.p.businessId,
          businessName: row.bName || null,
          productImage: row.p.imageUrl || null,
          isFeatured: row.isFeatured ?? null,
          baseScore,
          personalizationScore,
        });
      }
    }

    // ==================== SERVICES (Vendor) ====================
    if (scope === 'all' || scope === 'services') {
      const vendorServiceRows = await db
        .select({
          s: vendorServices,
          bName: businesses.name,
          bCity: businesses.city,
          bState: businesses.state,
          bOwnerId: businesses.ownerId,
          bStripe: businesses.stripeOnboardingComplete,
          bApproval: businesses.approvalStatus,
          isFeatured: vendorServices.isFeatured,
        })
        .from(vendorServices)
        .innerJoin(businesses, eq(vendorServices.businessId, businesses.id))
        .where(
          and(
            eq(vendorServices.status, 'live'),
            eq(vendorServices.isActive, true),
            or(
              ilike(vendorServices.name, likePattern),
              ilike(vendorServices.description, likePattern),
              ilike(vendorServices.category, likePattern)
            ),
            city ? ilike(businesses.city, `%${city}%`) : undefined,
            isAdmin ? undefined : eq(businesses.approvalStatus, 'approved'),
            isAdmin ? undefined : eq(businesses.stripeOnboardingComplete, true)
          )
        )
        .limit(scope === 'all' ? 10 : limit)
        .offset(scope === 'services' ? offset : 0);

      for (const row of vendorServiceRows) {
        if (!isAdmin && row.bOwnerId?.toLowerCase().includes('demo')) continue;

        const lower = searchTerm.toLowerCase();
        const nameLower = row.s.name.toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 80;
          else baseScore = 45;
        } else {
          baseScore = 25;
        }

        results.push({
          id: row.s.id,
          type: 'service',
          title: row.s.name,
          subtitle: row.bName
            ? `by ${row.bName}${row.bCity ? ` · ${row.bCity}` : ''}`
            : null,
          imageUrl: null,
          ratingAvg: null,
          ratingCount: null,
          category: row.s.category || null,
          providerUserId: row.bOwnerId || null,
          username: null,
          price: row.s.price,
          businessId: row.s.businessId,
          businessName: row.bName || null,
          providerName: row.bName || null,
          providerType: 'business',
          isFeatured: row.isFeatured ?? null,
          baseScore,
          personalizationScore: baseScore,
        });
      }

      // Also include photographer services
      const photographerServiceRows = await db
        .select({
          s: photographerServices,
          pId: photographers.id,
          pName: photographers.displayName,
          pCity: photographers.city,
          pState: photographers.state,
          pUserId: photographers.userId,
          pVisibility: photographers.visibilityStatus,
        })
        .from(photographerServices)
        .innerJoin(photographers, eq(photographerServices.photographerId, photographers.id))
        .where(
          and(
            eq(photographerServices.status, 'live'),
            eq(photographerServices.isActive, true),
            or(
              ilike(photographerServices.name, likePattern),
              ilike(photographerServices.description, likePattern),
              ilike(photographerServices.category, likePattern)
            ),
            city ? ilike(photographers.city, `%${city}%`) : undefined,
            isAdmin ? undefined : eq(photographers.visibilityStatus, 'public')
          )
        )
        .limit(scope === 'all' ? 10 : limit)
        .offset(0);

      for (const row of photographerServiceRows) {
        const lower = searchTerm.toLowerCase();
        const nameLower = row.s.name.toLowerCase();

        let baseScore = 0;
        if (searchTerm) {
          if (nameLower === lower) baseScore = 100;
          else if (nameLower.startsWith(lower)) baseScore = 80;
          else baseScore = 45;
        } else {
          baseScore = 25;
        }

        results.push({
          id: row.s.id,
          type: 'service',
          title: row.s.name,
          subtitle: row.pName
            ? `by ${row.pName}${row.pCity ? ` · ${row.pCity}` : ''}`
            : null,
          imageUrl: null,
          ratingAvg: null,
          ratingCount: null,
          category: row.s.category || 'Photography',
          providerUserId: row.pUserId,
          username: null,
          price: row.s.priceCents,
          providerId: row.pId,
          providerName: row.pName || null,
          providerType: 'photographer',
          baseScore,
          personalizationScore: baseScore,
        });
      }
    }

    // ==================== PERSONALIZATION RE-RANKING ====================
    let wasPersonalized = false;

    if (personalized && viewerUserId) {
      const boosts = await this.getPersonalizationBoosts(viewerUserId);
      const hasInterestData = Object.keys(boosts.interestVector).length > 0 ||
        boosts.followedSet.size > 0 ||
        boosts.reviewedTargetIds.size > 0;

      if (hasInterestData) {
        for (const r of results) {
          r.personalizationScore = this.applyPersonalizationScore(r, boosts);
        }
        wasPersonalized = true;
      }
    }

    // ==================== SORTING ====================
    results.sort((a, b) => {
      if (scope === 'all') {
        return (b.personalizationScore ?? b.baseScore) - (a.personalizationScore ?? a.baseScore);
      }
      if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
      return (b.ratingAvg || 0) - (a.ratingAvg || 0);
    });

    const total = results.length;
    const paginated = results.slice(offset, offset + limit);

    return {
      results: paginated,
      total,
      personalized: wasPersonalized,
    };
  }

  // =========================
  // SHIPMENT TRACKING
  // =========================

  async createShipment(data: InsertShipment): Promise<Shipment> {
    const id = randomUUID();
    const result = await db.insert(shipments).values({
      id,
      orderId: data.orderId,
      businessId: data.businessId,
      carrier: data.carrier,
      trackingNumber: data.trackingNumber,
      status: data.status ?? 'shipped',
      shippedAt: data.shippedAt ?? new Date(),
      deliveredAt: data.deliveredAt ?? null,
      estimatedDelivery: data.estimatedDelivery ?? null,
      notes: data.notes ?? null,
    }).returning();
    return result[0];
  }

  async getShipment(id: string): Promise<Shipment | undefined> {
    const result = await db.select().from(shipments).where(eq(shipments.id, id));
    return result[0];
  }

  async getShipmentsByOrder(orderId: string): Promise<Shipment[]> {
    return db.select().from(shipments)
      .where(eq(shipments.orderId, orderId))
      .orderBy(desc(shipments.createdAt));
  }

  async getShipmentsByBusiness(businessId: string): Promise<Shipment[]> {
    return db.select().from(shipments)
      .where(eq(shipments.businessId, businessId))
      .orderBy(desc(shipments.createdAt));
  }

  async updateShipment(id: string, updates: Partial<Shipment>): Promise<Shipment | undefined> {
    const result = await db.update(shipments)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(shipments.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // AUDIT LOGGING
  // =========================

  async createAuditLog(data: InsertAuditLog): Promise<AuditLog> {
    const id = randomUUID();
    const result = await db.insert(auditLogs).values({
      id,
      actorId: data.actorId ?? null,
      actorType: data.actorType,
      action: data.action,
      targetType: data.targetType,
      targetId: data.targetId,
      beforeState: data.beforeState ?? null,
      afterState: data.afterState ?? null,
      metadata: data.metadata ?? null,
      ipAddress: data.ipAddress ?? null,
      userAgent: data.userAgent ?? null,
    }).returning();
    return result[0];
  }

  async getAuditLogs(targetType: string, targetId: string): Promise<AuditLog[]> {
    return db.select().from(auditLogs)
      .where(and(
        eq(auditLogs.targetType, targetType),
        eq(auditLogs.targetId, targetId)
      ))
      .orderBy(desc(auditLogs.createdAt));
  }

  async getAuditLogsFiltered(filters: {
    action?: string;
    targetType?: string;
    targetId?: string;
    actorId?: string;
    limit?: number;
    offset?: number;
  }): Promise<AuditLog[]> {
    const conditions = [];
    
    if (filters.action) {
      conditions.push(eq(auditLogs.action, filters.action));
    }
    if (filters.targetType) {
      conditions.push(eq(auditLogs.targetType, filters.targetType));
    }
    if (filters.targetId) {
      conditions.push(eq(auditLogs.targetId, filters.targetId));
    }
    if (filters.actorId) {
      conditions.push(eq(auditLogs.actorId, filters.actorId));
    }

    let query = db.select().from(auditLogs);
    
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    
    return query
      .orderBy(desc(auditLogs.createdAt))
      .limit(filters.limit || 50)
      .offset(filters.offset || 0);
  }

  // =========================
  // ORDER STATE MACHINE
  // =========================

  async updateOrderWithValidation(
    orderId: string, 
    updates: Partial<Order>, 
    actorId?: string
  ): Promise<{ success: boolean; order?: Order; error?: string }> {
    const currentOrder = await this.getOrder(orderId);
    if (!currentOrder) {
      return { success: false, error: 'Order not found' };
    }

    if (updates.status && updates.status !== currentOrder.status) {
      if (!isValidOrderTransition(currentOrder.status || 'pending', updates.status)) {
        return { 
          success: false, 
          error: `Invalid status transition from '${currentOrder.status}' to '${updates.status}'` 
        };
      }
    }

    const beforeState = { ...currentOrder };
    const result = await db.update(orders)
      .set(updates)
      .where(eq(orders.id, orderId))
      .returning();
    
    if (!result[0]) {
      return { success: false, error: 'Failed to update order' };
    }

    await this.createAuditLog({
      actorId: actorId ?? null,
      actorType: actorId ? 'user' : 'system',
      action: 'order_status_change',
      targetType: 'order',
      targetId: orderId,
      beforeState: beforeState as unknown as Record<string, any>,
      afterState: result[0] as unknown as Record<string, any>,
      metadata: { statusChange: { from: currentOrder.status, to: updates.status } } as Record<string, any>
    });

    return { success: true, order: result[0] };
  }

  async updateBookingWithValidation(
    bookingId: string, 
    updates: Partial<ShootBooking>, 
    actorId?: string
  ): Promise<{ success: boolean; booking?: ShootBooking; error?: string }> {
    const currentBooking = await this.getShootBooking(bookingId);
    if (!currentBooking) {
      return { success: false, error: 'Booking not found' };
    }

    if (updates.status && updates.status !== currentBooking.status) {
      if (!isValidBookingTransition(currentBooking.status || 'pending', updates.status)) {
        return { 
          success: false, 
          error: `Invalid status transition from '${currentBooking.status}' to '${updates.status}'` 
        };
      }
    }

    const beforeState = { ...currentBooking };
    const result = await db.update(shootBookings)
      .set(updates)
      .where(eq(shootBookings.id, bookingId))
      .returning();
    
    if (!result[0]) {
      return { success: false, error: 'Failed to update booking' };
    }

    // Release availability slot when booking is cancelled or refunded
    if (updates.status && (updates.status === 'cancelled' || updates.status === 'refunded')) {
      await this.releasePhotographerSlot(bookingId);
    }

    await this.createAuditLog({
      actorId: actorId ?? null,
      actorType: actorId ? 'user' : 'system',
      action: 'booking_status_change',
      targetType: 'shoot_booking',
      targetId: bookingId,
      beforeState: beforeState as unknown as Record<string, any>,
      afterState: result[0] as unknown as Record<string, any>,
      metadata: { statusChange: { from: currentBooking.status, to: updates.status } } as Record<string, any>
    });

    return { success: true, booking: result[0] };
  }

  // =========================
  // POINT REVERSAL ON REFUND
  // =========================

  async reversePointsForRefund(
    userId: string,
    referenceType: string,
    referenceId: string,
    opts?: { refundFraction?: number; description?: string }
  ): Promise<{ reversed: boolean; pointsReversed: number; shortfall: number }> {
    const earnedTransactions = await db.select()
      .from(pointTransactions)
      .where(and(
        eq(pointTransactions.userId, userId),
        eq(pointTransactions.type, 'earn'),
        eq(pointTransactions.referenceType, referenceType),
        eq(pointTransactions.referenceId, referenceId)
      ));

    if (earnedTransactions.length === 0) {
      return { reversed: false, pointsReversed: 0, shortfall: 0 };
    }

    const totalPointsEarned = earnedTransactions.reduce((sum, tx) => sum + tx.points, 0);

    // Proportional clawback: fraction 0.0–1.0 for partial refunds, omit for full reversal.
    const fraction = opts?.refundFraction !== undefined
      ? Math.min(1, Math.max(0, opts.refundFraction))
      : 1;
    const pointsToReverse = Math.round(totalPointsEarned * fraction);

    if (pointsToReverse === 0) {
      return { reversed: false, pointsReversed: 0, shortfall: 0 };
    }

    const currentBalance = await this.getUserPointsBalance(userId);
    const actualDecrement = Math.min(currentBalance, pointsToReverse);
    const newBalance = currentBalance - actualDecrement;
    const shortfall = pointsToReverse - actualDecrement;

    if (shortfall > 0) {
      console.warn(
        `[Points] Clawback shortfall for user ${userId} on ${referenceType} ${referenceId}: ` +
        `tried to reverse ${pointsToReverse} pts, balance was only ${currentBalance}. ` +
        `${shortfall} pts could not be recovered (already redeemed).`
      );
    }

    await db.update(users)
      .set({ loyaltyPoints: newBalance })
      .where(eq(users.id, userId));

    const description = opts?.description
      || (fraction < 1
        ? `Points reversed from partial refund (${referenceType})`
        : `Points reversed from refund (${referenceType})`);

    await db.insert(pointTransactions).values({
      id: randomUUID(),
      userId,
      type: 'reversal',
      points: -pointsToReverse,
      dollarAmountCents: 0,
      referenceType: 'refund_reversal',
      referenceId,
      balanceAfter: newBalance,
      description,
      capped: false,
    });

    return { reversed: true, pointsReversed: pointsToReverse, shortfall };
  }

  // =========================
  // REVIEW REVOCATION ON REFUND
  // =========================

  async revokeReviewsForRefund(bookingType: string, bookingId: string): Promise<number> {
    const reviewsToRevoke = await db.select()
      .from(reviews)
      .where(and(
        eq(reviews.bookingType, bookingType),
        eq(reviews.bookingId, bookingId)
      ));

    if (reviewsToRevoke.length === 0) {
      return 0;
    }

    await db.update(reviews)
      .set({ isVerified: false })
      .where(and(
        eq(reviews.bookingType, bookingType),
        eq(reviews.bookingId, bookingId)
      ));

    for (const review of reviewsToRevoke) {
      await this.updateTargetRating(review.targetType, review.targetId);
    }

    return reviewsToRevoke.length;
  }

  // =========================
  // INFLUENCER PROFILES
  // =========================

  async createInfluencerProfile(data: InsertInfluencerProfile): Promise<InfluencerProfile> {
    const id = randomUUID();
    const result = await db.insert(influencerProfiles).values({
      id,
      ...data,
    }).returning();
    return result[0];
  }

  async getInfluencerProfile(id: string): Promise<InfluencerProfile | undefined> {
    const result = await db.select().from(influencerProfiles).where(eq(influencerProfiles.id, id));
    return result[0];
  }

  async getInfluencerProfileByUserId(userId: string): Promise<InfluencerProfile | undefined> {
    const result = await db.select().from(influencerProfiles).where(eq(influencerProfiles.userId, userId));
    return result[0];
  }

  async getInfluencerProfileByPromoCode(promoCode: string): Promise<InfluencerProfile | undefined> {
    const result = await db.select().from(influencerProfiles).where(eq(influencerProfiles.promoCode, promoCode));
    return result[0];
  }

  async updateInfluencerProfile(id: string, updates: Partial<InfluencerProfile>): Promise<InfluencerProfile | undefined> {
    const result = await db.update(influencerProfiles)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(influencerProfiles.id, id))
      .returning();
    return result[0];
  }

  async listInfluencerProfiles(): Promise<InfluencerProfile[]> {
    return db.select().from(influencerProfiles).orderBy(desc(influencerProfiles.createdAt));
  }

  // =========================
  // INFLUENCER APPLICATIONS
  // =========================

  async createInfluencerApplication(data: InsertInfluencerApplication): Promise<InfluencerApplication> {
    const id = randomUUID();
    const result = await db.insert(influencerApplications).values({
      id,
      ...data,
    }).returning();
    return result[0];
  }

  async getInfluencerApplication(id: string): Promise<InfluencerApplication | undefined> {
    const result = await db.select().from(influencerApplications).where(eq(influencerApplications.id, id));
    return result[0];
  }

  async getInfluencerApplicationByUserId(userId: string): Promise<InfluencerApplication | undefined> {
    const result = await db.select()
      .from(influencerApplications)
      .where(eq(influencerApplications.userId, userId))
      .orderBy(desc(influencerApplications.createdAt));
    return result[0];
  }

  async getInfluencerApplications(status?: string): Promise<InfluencerApplication[]> {
    if (status) {
      return db.select().from(influencerApplications)
        .where(eq(influencerApplications.status, status))
        .orderBy(desc(influencerApplications.createdAt));
    }
    return db.select().from(influencerApplications).orderBy(desc(influencerApplications.createdAt));
  }

  async updateInfluencerApplication(id: string, updates: Partial<InfluencerApplication>): Promise<InfluencerApplication | undefined> {
    const result = await db.update(influencerApplications)
      .set(updates)
      .where(eq(influencerApplications.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // INFLUENCER CAMPAIGNS
  // =========================

  async createInfluencerCampaign(data: InsertInfluencerCampaign): Promise<InfluencerCampaign> {
    const id = randomUUID();
    const result = await db.insert(influencerCampaigns).values({
      id,
      name: data.name,
      description: data.description,
      createdByVendorId: data.createdByVendorId,
      createdByAdminId: data.createdByAdminId,
      payoutType: data.payoutType,
      flatAmountCents: data.flatAmountCents,
      commissionBps: data.commissionBps,
      targetProductIds: data.targetProductIds ? [...data.targetProductIds] : [],
      targetServiceIds: data.targetServiceIds ? [...data.targetServiceIds] : [],
      startDate: data.startDate,
      endDate: data.endDate,
      status: data.status,
    }).returning();
    return result[0];
  }

  async getInfluencerCampaign(id: string): Promise<InfluencerCampaign | undefined> {
    const result = await db.select().from(influencerCampaigns).where(eq(influencerCampaigns.id, id));
    return result[0];
  }

  async getInfluencerCampaigns(filters?: { vendorId?: string; adminId?: string; status?: string }): Promise<InfluencerCampaign[]> {
    let query = db.select().from(influencerCampaigns);
    const conditions: any[] = [];
    
    if (filters?.vendorId) {
      conditions.push(eq(influencerCampaigns.createdByVendorId, filters.vendorId));
    }
    if (filters?.adminId) {
      conditions.push(eq(influencerCampaigns.createdByAdminId, filters.adminId));
    }
    if (filters?.status) {
      conditions.push(eq(influencerCampaigns.status, filters.status));
    }

    if (conditions.length > 0) {
      return db.select().from(influencerCampaigns)
        .where(and(...conditions))
        .orderBy(desc(influencerCampaigns.createdAt));
    }
    return db.select().from(influencerCampaigns).orderBy(desc(influencerCampaigns.createdAt));
  }

  async updateInfluencerCampaign(id: string, updates: Partial<InfluencerCampaign>): Promise<InfluencerCampaign | undefined> {
    const result = await db.update(influencerCampaigns)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(influencerCampaigns.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // INFLUENCER CAMPAIGN ASSIGNMENTS
  // =========================

  async createInfluencerCampaignAssignment(data: InsertInfluencerCampaignAssignment): Promise<InfluencerCampaignAssignment> {
    const id = randomUUID();
    const result = await db.insert(influencerCampaignAssignments).values({
      id,
      ...data,
    }).returning();
    return result[0];
  }

  async getInfluencerCampaignAssignment(id: string): Promise<InfluencerCampaignAssignment | undefined> {
    const result = await db.select().from(influencerCampaignAssignments).where(eq(influencerCampaignAssignments.id, id));
    return result[0];
  }

  async getInfluencerCampaignAssignments(filters?: { campaignId?: string; influencerId?: string; status?: string }): Promise<InfluencerCampaignAssignment[]> {
    const conditions: any[] = [];
    
    if (filters?.campaignId) {
      conditions.push(eq(influencerCampaignAssignments.campaignId, filters.campaignId));
    }
    if (filters?.influencerId) {
      conditions.push(eq(influencerCampaignAssignments.influencerId, filters.influencerId));
    }
    if (filters?.status) {
      conditions.push(eq(influencerCampaignAssignments.status, filters.status));
    }

    if (conditions.length > 0) {
      return db.select().from(influencerCampaignAssignments)
        .where(and(...conditions))
        .orderBy(desc(influencerCampaignAssignments.createdAt));
    }
    return db.select().from(influencerCampaignAssignments).orderBy(desc(influencerCampaignAssignments.createdAt));
  }

  async updateInfluencerCampaignAssignment(id: string, updates: Partial<InfluencerCampaignAssignment>): Promise<InfluencerCampaignAssignment | undefined> {
    const result = await db.update(influencerCampaignAssignments)
      .set(updates)
      .where(eq(influencerCampaignAssignments.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // INFLUENCER REFERRAL EVENTS
  // =========================

  async createInfluencerReferralEvent(data: InsertInfluencerReferralEvent): Promise<InfluencerReferralEvent> {
    const id = randomUUID();
    const result = await db.insert(influencerReferralEvents).values({
      id,
      ...data,
    }).returning();
    return result[0];
  }

  async getInfluencerReferralEvents(influencerId: string): Promise<InfluencerReferralEvent[]> {
    return db.select().from(influencerReferralEvents)
      .where(eq(influencerReferralEvents.influencerId, influencerId))
      .orderBy(desc(influencerReferralEvents.createdAt));
  }

  async getInfluencerReferralEventsByOrder(orderId: string): Promise<InfluencerReferralEvent[]> {
    return db.select().from(influencerReferralEvents)
      .where(eq(influencerReferralEvents.orderId, orderId))
      .orderBy(desc(influencerReferralEvents.createdAt));
  }

  async updateInfluencerReferralEvent(id: string, updates: Partial<InfluencerReferralEvent>): Promise<InfluencerReferralEvent | undefined> {
    const result = await db.update(influencerReferralEvents)
      .set(updates)
      .where(eq(influencerReferralEvents.id, id))
      .returning();
    return result[0];
  }

  async markInfluencerReferralEventCredited(eventId: string, ledgerEntryId: string): Promise<boolean> {
    const result = await db.update(influencerReferralEvents)
      .set({
        creditedAt: new Date(),
        ledgerEntryId: ledgerEntryId,
      })
      .where(and(
        eq(influencerReferralEvents.id, eventId),
        isNull(influencerReferralEvents.creditedAt)
      ))
      .returning();
    return result.length > 0;
  }

  // =========================
  // INFLUENCER EARNING LEDGER
  // =========================

  async createInfluencerEarningLedger(data: InsertInfluencerEarningLedger): Promise<InfluencerEarningLedger> {
    const id = randomUUID();
    const result = await db.insert(influencerEarningLedger).values({
      id,
      ...data,
    }).returning();
    return result[0];
  }

  async getInfluencerEarningLedger(influencerId: string, status?: string): Promise<InfluencerEarningLedger[]> {
    if (status) {
      return db.select().from(influencerEarningLedger)
        .where(and(
          eq(influencerEarningLedger.influencerId, influencerId),
          eq(influencerEarningLedger.status, status)
        ))
        .orderBy(desc(influencerEarningLedger.createdAt));
    }
    return db.select().from(influencerEarningLedger)
      .where(eq(influencerEarningLedger.influencerId, influencerId))
      .orderBy(desc(influencerEarningLedger.createdAt));
  }

  async updateInfluencerEarningLedger(id: string, updates: Partial<InfluencerEarningLedger>): Promise<InfluencerEarningLedger | undefined> {
    const result = await db.update(influencerEarningLedger)
      .set(updates)
      .where(eq(influencerEarningLedger.id, id))
      .returning();
    return result[0];
  }

  async getReadyForPayoutLedgerEntries(influencerId: string): Promise<InfluencerEarningLedger[]> {
    return db.select().from(influencerEarningLedger)
      .where(and(
        eq(influencerEarningLedger.influencerId, influencerId),
        eq(influencerEarningLedger.status, 'ready_for_payout')
      ))
      .orderBy(asc(influencerEarningLedger.createdAt));
  }

  // =========================
  // INFLUENCER PAYOUTS
  // =========================

  async createInfluencerPayout(data: InsertInfluencerPayout): Promise<InfluencerPayout> {
    const id = randomUUID();
    const result = await db.insert(influencerPayouts).values({
      id,
      influencerId: data.influencerId,
      amountCents: data.amountCents,
      ledgerIds: data.ledgerIds ? [...data.ledgerIds] : [],
      stripeTransferId: data.stripeTransferId,
      status: data.status,
    }).returning();
    return result[0];
  }

  async getInfluencerPayout(id: string): Promise<InfluencerPayout | undefined> {
    const result = await db.select().from(influencerPayouts).where(eq(influencerPayouts.id, id));
    return result[0];
  }

  async getInfluencerPayouts(influencerId: string): Promise<InfluencerPayout[]> {
    return db.select().from(influencerPayouts)
      .where(eq(influencerPayouts.influencerId, influencerId))
      .orderBy(desc(influencerPayouts.initiatedAt));
  }

  async updateInfluencerPayout(id: string, updates: Partial<InfluencerPayout>): Promise<InfluencerPayout | undefined> {
    const result = await db.update(influencerPayouts)
      .set(updates)
      .where(eq(influencerPayouts.id, id))
      .returning();
    return result[0];
  }

  // =========================
  // FOLLOWS (Private)
  // =========================

  async createFollow(data: InsertFollow): Promise<Follow> {
    const id = randomUUID();
    const result = await db.insert(follows).values({
      id,
      followerUserId: data.followerUserId,
      targetUserId: data.targetUserId,
    }).returning();
    return result[0];
  }

  async getFollow(followerUserId: string, targetUserId: string): Promise<Follow | undefined> {
    const result = await db.select().from(follows)
      .where(and(
        eq(follows.followerUserId, followerUserId),
        eq(follows.targetUserId, targetUserId)
      ));
    return result[0];
  }

  async deleteFollow(followerUserId: string, targetUserId: string): Promise<void> {
    await db.delete(follows)
      .where(and(
        eq(follows.followerUserId, followerUserId),
        eq(follows.targetUserId, targetUserId)
      ));
  }

  async getUserFollowing(userId: string, limit: number = 50, offset: number = 0): Promise<User[]> {
    const result = await db.select({
      user: users
    })
      .from(follows)
      .innerJoin(users, eq(follows.targetUserId, users.id))
      .where(eq(follows.followerUserId, userId))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);
    return result.map(r => r.user);
  }

  async getUserFollowers(userId: string, limit: number = 50, offset: number = 0): Promise<User[]> {
    const result = await db.select({
      user: users
    })
      .from(follows)
      .innerJoin(users, eq(follows.followerUserId, users.id))
      .where(eq(follows.targetUserId, userId))
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset(offset);
    return result.map(r => r.user);
  }

  async getFollowingCount(userId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.followerUserId, userId));
    return result[0]?.count || 0;
  }

  async getFollowerCount(userId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.targetUserId, userId));
    return result[0]?.count || 0;
  }

  // =========================
  // WEEKLY AVAILABILITY
  // =========================

  async getWeeklyAvailability(providerType: string, providerId: string, staffMemberId?: string): Promise<WeeklyAvailability[]> {
    const conditions = [
      eq(weeklyAvailability.providerType, providerType),
      eq(weeklyAvailability.providerId, providerId),
    ];
    
    if (staffMemberId) {
      conditions.push(eq(weeklyAvailability.staffMemberId, staffMemberId));
    } else {
      conditions.push(isNull(weeklyAvailability.staffMemberId));
    }
    
    return await db.select()
      .from(weeklyAvailability)
      .where(and(...conditions))
      .orderBy(asc(weeklyAvailability.dayOfWeek), asc(weeklyAvailability.startTime));
  }

  async setWeeklyAvailability(
    providerType: string, 
    providerId: string, 
    slots: InsertWeeklyAvailability[], 
    staffMemberId?: string
  ): Promise<WeeklyAvailability[]> {
    const deleteConditions = [
      eq(weeklyAvailability.providerType, providerType),
      eq(weeklyAvailability.providerId, providerId),
    ];
    
    if (staffMemberId) {
      deleteConditions.push(eq(weeklyAvailability.staffMemberId, staffMemberId));
    } else {
      deleteConditions.push(isNull(weeklyAvailability.staffMemberId));
    }
    
    await db.delete(weeklyAvailability).where(and(...deleteConditions));
    
    if (slots.length === 0) {
      return [];
    }
    
    const insertData = slots.map(slot => ({
      ...slot,
      providerType,
      providerId,
      staffMemberId: staffMemberId || null,
    }));
    
    return await db.insert(weeklyAvailability).values(insertData).returning();
  }

  // =========================
  // PROVIDER BLOCKS
  // =========================

  async getProviderBlocks(
    providerType: string, 
    providerId: string, 
    startDate: Date, 
    endDate: Date, 
    staffMemberId?: string
  ): Promise<ProviderBlock[]> {
    const conditions = [
      eq(providerBlocks.providerType, providerType),
      eq(providerBlocks.providerId, providerId),
      lte(providerBlocks.startAt, endDate),
      gte(providerBlocks.endAt, startDate),
    ];
    
    if (staffMemberId) {
      conditions.push(eq(providerBlocks.staffMemberId, staffMemberId));
    }
    
    return await db.select()
      .from(providerBlocks)
      .where(and(...conditions))
      .orderBy(asc(providerBlocks.startAt));
  }

  async createProviderBlock(data: InsertProviderBlock): Promise<ProviderBlock> {
    const [block] = await db.insert(providerBlocks).values(data).returning();
    return block;
  }

  async updateProviderBlock(id: string, updates: Partial<ProviderBlock>): Promise<ProviderBlock | undefined> {
    const [updated] = await db.update(providerBlocks)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(providerBlocks.id, id))
      .returning();
    return updated;
  }

  async deleteProviderBlock(id: string): Promise<void> {
    await db.delete(providerBlocks).where(eq(providerBlocks.id, id));
  }

  // ── Consumer address book ───────────────────────────────────────────────────

  async getConsumerAddresses(userId: string): Promise<ConsumerAddress[]> {
    return db
      .select()
      .from(consumerAddresses)
      .where(eq(consumerAddresses.userId, userId))
      .orderBy(desc(consumerAddresses.isDefault), asc(consumerAddresses.createdAt));
  }

  async createConsumerAddress(data: InsertConsumerAddress): Promise<ConsumerAddress> {
    const [created] = await db.insert(consumerAddresses).values(data).returning();
    return created;
  }

  async updateConsumerAddress(
    id: string,
    userId: string,
    data: Partial<InsertConsumerAddress>,
  ): Promise<ConsumerAddress> {
    const [updated] = await db
      .update(consumerAddresses)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(consumerAddresses.id, id), eq(consumerAddresses.userId, userId)))
      .returning();
    if (!updated) throw new Error('Address not found or access denied');
    return updated;
  }

  async deleteConsumerAddress(id: string, userId: string): Promise<void> {
    await db
      .delete(consumerAddresses)
      .where(and(eq(consumerAddresses.id, id), eq(consumerAddresses.userId, userId)));
  }
}

export const storage = new DatabaseStorage();
