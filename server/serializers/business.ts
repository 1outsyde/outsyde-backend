// server/serializers/business.ts
import type { Business } from "@shared/schema";
import { coverPosterUrl } from "../coverMedia";

export interface PublicBusinessDTOOptions {
  followerCount: number;
  followingCount: number;
}

// Curated, allowlist-based public representation of a business.
// Never spread the raw row here — every field returned to unauthenticated
// clients must be explicitly listed below. This keeps internal/financial/
// moderation fields (stripeAccountId, billingAddress, approvalNotes,
// approvedBy, isDemo, subscriptionActive, employeeCount, businessType, etc.)
// from ever leaking through this DTO.
export function toPublicBusinessDTO(
  business: Business,
  opts: PublicBusinessDTOOptions
) {
  // R40 (Legend 2026-11-06): the vendor's "show address" switch is enforced
  // here, not only on screen. Hidden → no street, zip or map spot (the map spot
  // is geocoded from the street at signup). City and state stay.
  const hideStreet = business.showAddress === false;
  return {
    id: business.id,
    ownerId: business.ownerId,

    name: business.name,
    category: business.category,
    description: business.description,

    isStartup: business.isStartup,
    yearsInBusiness: business.yearsInBusiness,

    hasPhysicalLocation: business.hasPhysicalLocation,
    showAddress: business.showAddress,
    address: hideStreet ? null : business.address,
    city: business.city,
    state: business.state,
    zipCode: hideStreet ? null : business.zipCode,
    country: business.country,
    latitude: hideStreet ? null : business.latitude,
    longitude: hideStreet ? null : business.longitude,

    websiteUrl: business.showWebsite ? business.websiteUrl : null,
    socialMedia: business.socialMedia,

    coverImage: business.coverImage,
    coverMediaType: business.coverMediaType,
    // Still picture for image-only screens (Mux thumbnail for video covers). Additive.
    coverPosterUrl: coverPosterUrl(business.coverImage, business.coverMediaType),
    logoImage: business.logoImage,

    rating: business.rating,
    reviewCount: business.reviewCount,

    tagline: business.tagline,
    hoursOfOperation: business.showStoreHours ? business.hoursOfOperation : null,
    contactEmail: business.showEmail ? business.contactEmail : null,
    contactPhone: business.showPhone ? business.contactPhone : null,
    brandColors: business.brandColors,
    knownFor: business.knownFor,

    hasProducts: business.hasProducts,
    hasServices: business.hasServices,
    isMultiStaff: business.isMultiStaff,
    defaultServiceLocationType: business.defaultServiceLocationType,

    autoAcceptBookings: business.autoAcceptBookings,
    allowPastClosing: business.allowPastClosing ?? false,
    responseTimeValue: business.showResponseTime ? business.responseTimeValue : null,
    responseTimeUnit: business.showResponseTime ? business.responseTimeUnit : null,

    vendorTermsAndConditions: business.vendorTermsAndConditions ?? null,

    createdAt: business.createdAt,

    followerCount: opts.followerCount,
    followingCount: opts.followingCount,

    acceptsOnlinePayments: !!(business.stripeAccountId && business.stripeOnboardingComplete),

    ctaConfig: business.ctaConfig ?? null,
    siteConfig: business.siteConfig ?? null,
    // Migration 068: cities the business serves (its site's estimate form). Additive field.
    serviceCities: business.serviceCities ?? [],
  };
}
