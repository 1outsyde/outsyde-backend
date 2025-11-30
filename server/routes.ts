import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { 
  customerSignupSchema, 
  vendorSignupSchema, 
  loginSchema 
} from "@shared/schema";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  authMiddleware,
  optionalAuthMiddleware,
  type AuthenticatedRequest,
} from "./auth";

// Legacy password functions for backward compatibility with existing users
function legacyHashPassword(password: string): string {
  return Buffer.from(password).toString('base64');
}

function legacyVerifyPassword(password: string, hash: string): boolean {
  return legacyHashPassword(password) === hash;
}

// Check if password is legacy (base64) or new (bcrypt)
function isLegacyHash(hash: string): boolean {
  return !hash.startsWith('$2');
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // ==================== AUTH ROUTES ====================
  
  // Customer signup
  app.post("/api/auth/customer/signup", async (req, res) => {
    try {
      const data = customerSignupSchema.parse(req.body);
      
      // Check if user already exists
      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }
      
      // Create user with bcrypt hashed password
      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: false,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        ageRange: data.ageRange,
        gender: data.gender,
        ethnicity: data.ethnicity,
        nationality: data.nationality,
        householdSize: data.householdSize,
        incomeRange: data.incomeRange,
        education: data.education,
        occupation: data.occupation,
        shoppingFrequency: data.shoppingFrequency,
        selectedIndustries: data.selectedIndustries,
        industryNiches: data.industryNiches,
      });
      
      // Set session
      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = false;
      }
      
      // Return user without password
      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Customer signup error:", error);
      res.status(500).json({ error: "Signup failed" });
    }
  });
  
  // Vendor signup
  app.post("/api/auth/vendor/signup", async (req, res) => {
    try {
      const data = vendorSignupSchema.parse(req.body);
      
      // Check if user already exists
      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ error: "Email already registered" });
      }
      
      // Create user with bcrypt hashed password
      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: true,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
      });
      
      // Create business
      const business = await storage.createBusiness({
        ownerId: user.id,
        name: data.businessName,
        category: data.businessCategory,
        description: data.businessDescription,
        isStartup: data.isStartup,
        yearsInBusiness: data.yearsInBusiness,
        employeeCount: data.employeeCount,
        businessType: data.businessType,
        hasPhysicalLocation: data.hasPhysicalLocation,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        websiteUrl: data.websiteUrl,
        socialMedia: data.socialMedia,
        subscriptionActive: true, // Activated after subscription payment
      });
      
      // Set session
      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = true;
        req.session.businessId = business.id;
      }
      
      // Return user and business without password
      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser, business });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      console.error("Vendor signup error:", error);
      res.status(500).json({ error: "Signup failed" });
    }
  });
  
  // Login (supports both legacy base64 and new bcrypt passwords)
  app.post("/api/auth/login", async (req, res) => {
    try {
      const data = loginSchema.parse(req.body);
      
      const user = await storage.getUserByEmail(data.email);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      
      // Check password - support both legacy and new hashes
      let isValidPassword = false;
      if (isLegacyHash(user.password)) {
        isValidPassword = legacyVerifyPassword(data.password, user.password);
      } else {
        isValidPassword = await verifyPassword(data.password, user.password);
      }
      
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      
      // Set session
      if (req.session) {
        req.session.userId = user.id;
        req.session.isVendor = user.isVendor;
        
        if (user.isVendor) {
          const business = await storage.getBusinessByOwnerId(user.id);
          if (business) {
            req.session.businessId = business.id;
          }
        }
      }
      
      // Return user without password
      const { password: _, ...safeUser } = user;
      
      // If vendor, include business info
      if (user.isVendor) {
        const business = await storage.getBusinessByOwnerId(user.id);
        return res.json({ user: safeUser, business });
      }
      
      res.json({ user: safeUser });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data" });
      }
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });
  
  // Logout
  app.post("/api/auth/logout", (req, res) => {
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          return res.status(500).json({ error: "Logout failed" });
        }
        res.json({ success: true });
      });
    } else {
      res.json({ success: true });
    }
  });
  
  // Get current user
  app.get("/api/auth/me", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const user = await storage.getUser(userId);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    
    const { password: _, ...safeUser } = user;
    
    if (user.isVendor) {
      const business = await storage.getBusinessByOwnerId(user.id);
      return res.json({ user: safeUser, business });
    }
    
    res.json({ user: safeUser });
  });
  
  // ==================== USER PREFERENCES ROUTES ====================
  
  // Update user preferences (industry/niche selections)
  app.patch("/api/users/preferences", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    try {
      const { selectedIndustries, industryNiches } = req.body;
      
      const user = await storage.updateUser(userId, {
        selectedIndustries: selectedIndustries || [],
        industryNiches: industryNiches || {},
      });
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (error) {
      console.error("Update preferences error:", error);
      res.status(500).json({ error: "Failed to update preferences" });
    }
  });
  
  // ==================== BUSINESS ROUTES ====================
  
  // Get all businesses (with optional filters)
  app.get("/api/businesses", async (req, res) => {
    try {
      const { city, category, search } = req.query;
      
      const businesses = await storage.getBusinesses({
        city: city as string | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
      });
      
      res.json({ businesses });
    } catch (error) {
      console.error("Get businesses error:", error);
      res.status(500).json({ error: "Failed to fetch businesses" });
    }
  });
  
  // Get single business
  app.get("/api/businesses/:id", async (req, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      
      res.json({ business });
    } catch (error) {
      console.error("Get business error:", error);
      res.status(500).json({ error: "Failed to fetch business" });
    }
  });
  
  // Update business (vendor only)
  app.patch("/api/businesses/:id", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    try {
      const business = await storage.getBusiness(req.params.id);
      
      if (!business) {
        return res.status(404).json({ error: "Business not found" });
      }
      
      if (business.ownerId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      
      const updated = await storage.updateBusiness(req.params.id, req.body);
      res.json({ business: updated });
    } catch (error) {
      console.error("Update business error:", error);
      res.status(500).json({ error: "Failed to update business" });
    }
  });
  
  // ==================== CITY ROUTES ====================
  
  // Get all cities
  app.get("/api/cities", async (req, res) => {
    try {
      const cities = await storage.getCities();
      res.json({ cities });
    } catch (error) {
      console.error("Get cities error:", error);
      res.status(500).json({ error: "Failed to fetch cities" });
    }
  });
  
  // Get single city
  app.get("/api/cities/:id", async (req, res) => {
    try {
      const city = await storage.getCity(req.params.id);
      
      if (!city) {
        return res.status(404).json({ error: "City not found" });
      }
      
      res.json({ city });
    } catch (error) {
      console.error("Get city error:", error);
      res.status(500).json({ error: "Failed to fetch city" });
    }
  });

  // ==================== MOBILE API v1 (JWT Auth) ====================
  
  // V1 Customer Signup - Returns JWT tokens
  app.post("/api/v1/auth/customer/signup", async (req, res) => {
    try {
      const data = customerSignupSchema.parse(req.body);
      
      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "EMAIL_EXISTS", message: "Email already registered" }
        });
      }
      
      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: false,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        ageRange: data.ageRange,
        gender: data.gender,
        ethnicity: data.ethnicity,
        nationality: data.nationality,
        householdSize: data.householdSize,
        incomeRange: data.incomeRange,
        education: data.education,
        occupation: data.occupation,
        shoppingFrequency: data.shoppingFrequency,
        selectedIndustries: data.selectedIndustries,
        industryNiches: data.industryNiches,
      });
      
      const tokenPayload = { userId: user.id, isVendor: false };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      
      await storage.revokeAllUserRefreshTokens(user.id);
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);
      await storage.storeRefreshToken(user.id, refreshToken, refreshExpiry);
      
      const { password: _, ...safeUser } = user;
      res.json({ 
        success: true, 
        data: { 
          accessToken, 
          refreshToken, 
          user: safeUser 
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "VALIDATION_ERROR", message: "Invalid data", details: error.errors }
        });
      }
      console.error("V1 Customer signup error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "SIGNUP_FAILED", message: "Signup failed" }
      });
    }
  });
  
  // V1 Vendor Signup - Returns JWT tokens
  app.post("/api/v1/auth/vendor/signup", async (req, res) => {
    try {
      const data = vendorSignupSchema.parse(req.body);
      
      const existing = await storage.getUserByEmail(data.email);
      if (existing) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "EMAIL_EXISTS", message: "Email already registered" }
        });
      }
      
      const hashedPassword = await hashPassword(data.password);
      const user = await storage.createUser({
        email: data.email,
        password: hashedPassword,
        name: data.name,
        phone: data.phone,
        isVendor: true,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
      });
      
      const business = await storage.createBusiness({
        ownerId: user.id,
        name: data.businessName,
        category: data.businessCategory,
        description: data.businessDescription,
        isStartup: data.isStartup,
        yearsInBusiness: data.yearsInBusiness,
        employeeCount: data.employeeCount,
        businessType: data.businessType,
        hasPhysicalLocation: data.hasPhysicalLocation,
        address: data.address,
        city: data.city,
        state: data.state,
        zipCode: data.zipCode,
        websiteUrl: data.websiteUrl,
        socialMedia: data.socialMedia,
        subscriptionActive: true,
      });
      
      const tokenPayload = { userId: user.id, isVendor: true, businessId: business.id };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      
      await storage.revokeAllUserRefreshTokens(user.id);
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);
      await storage.storeRefreshToken(user.id, refreshToken, refreshExpiry);
      
      const { password: _, ...safeUser } = user;
      res.json({ 
        success: true, 
        data: { 
          accessToken, 
          refreshToken, 
          user: safeUser, 
          business 
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "VALIDATION_ERROR", message: "Invalid data", details: error.errors }
        });
      }
      console.error("V1 Vendor signup error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "SIGNUP_FAILED", message: "Signup failed" }
      });
    }
  });
  
  // V1 Login - Returns JWT tokens
  app.post("/api/v1/auth/login", async (req, res) => {
    try {
      const data = loginSchema.parse(req.body);
      
      const user = await storage.getUserByEmail(data.email);
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" }
        });
      }
      
      let isValidPassword = false;
      if (isLegacyHash(user.password)) {
        isValidPassword = legacyVerifyPassword(data.password, user.password);
      } else {
        isValidPassword = await verifyPassword(data.password, user.password);
      }
      
      if (!isValidPassword) {
        return res.status(401).json({ 
          success: false, 
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" }
        });
      }
      
      let business = null;
      if (user.isVendor) {
        business = await storage.getBusinessByOwnerId(user.id);
      }
      
      const tokenPayload = { 
        userId: user.id, 
        isVendor: user.isVendor,
        businessId: business?.id 
      };
      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);
      
      await storage.revokeAllUserRefreshTokens(user.id);
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);
      await storage.storeRefreshToken(user.id, refreshToken, refreshExpiry);
      
      const { password: _, ...safeUser } = user;
      res.json({ 
        success: true, 
        data: { 
          accessToken, 
          refreshToken, 
          user: safeUser,
          ...(business && { business })
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "VALIDATION_ERROR", message: "Invalid data" }
        });
      }
      console.error("V1 Login error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "LOGIN_FAILED", message: "Login failed" }
      });
    }
  });
  
  // V1 Token Refresh - Exchange refresh token for new access token
  app.post("/api/v1/auth/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json({ 
          success: false, 
          error: { code: "NO_TOKEN", message: "Refresh token required" }
        });
      }
      
      const payload = verifyRefreshToken(refreshToken);
      if (!payload) {
        return res.status(401).json({ 
          success: false, 
          error: { code: "TOKEN_INVALID", message: "Invalid or expired refresh token" }
        });
      }
      
      const storedToken = await storage.validateRefreshToken(refreshToken);
      if (!storedToken) {
        return res.status(401).json({ 
          success: false, 
          error: { code: "TOKEN_REVOKED", message: "Refresh token has been revoked or expired" }
        });
      }
      
      const user = await storage.getUser(payload.userId);
      if (!user) {
        return res.status(401).json({ 
          success: false, 
          error: { code: "USER_NOT_FOUND", message: "User not found" }
        });
      }
      
      await storage.revokeRefreshToken(storedToken.tokenId);
      
      let business = null;
      if (user.isVendor) {
        business = await storage.getBusinessByOwnerId(user.id);
      }
      
      const newTokenPayload = { 
        userId: user.id, 
        isVendor: user.isVendor,
        businessId: business?.id 
      };
      const newAccessToken = generateAccessToken(newTokenPayload);
      const newRefreshToken = generateRefreshToken(newTokenPayload);
      
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);
      await storage.storeRefreshToken(user.id, newRefreshToken, refreshExpiry);
      
      res.json({ 
        success: true, 
        data: { 
          accessToken: newAccessToken, 
          refreshToken: newRefreshToken 
        }
      });
    } catch (error) {
      console.error("V1 Token refresh error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "REFRESH_FAILED", message: "Token refresh failed" }
      });
    }
  });
  
  // V1 Get Current User (requires Bearer token)
  app.get("/api/v1/auth/me", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const user = await storage.getUser(req.user!.userId);
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: { code: "USER_NOT_FOUND", message: "User not found" }
        });
      }
      
      const { password: _, ...safeUser } = user;
      
      let business = null;
      if (user.isVendor) {
        business = await storage.getBusinessByOwnerId(user.id);
      }
      
      res.json({ 
        success: true, 
        data: { 
          user: safeUser,
          ...(business && { business })
        }
      });
    } catch (error) {
      console.error("V1 Get user error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "FETCH_FAILED", message: "Failed to fetch user" }
      });
    }
  });
  
  // V1 Update Preferences (requires Bearer token)
  app.patch("/api/v1/users/preferences", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const { selectedIndustries, industryNiches } = req.body;
      
      const user = await storage.updateUser(req.user!.userId, {
        selectedIndustries: selectedIndustries || [],
        industryNiches: industryNiches || {},
      });
      
      if (!user) {
        return res.status(404).json({ 
          success: false, 
          error: { code: "USER_NOT_FOUND", message: "User not found" }
        });
      }
      
      const { password: _, ...safeUser } = user;
      res.json({ success: true, data: { user: safeUser } });
    } catch (error) {
      console.error("V1 Update preferences error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "UPDATE_FAILED", message: "Failed to update preferences" }
      });
    }
  });
  
  // V1 Get Businesses (public, optional auth)
  app.get("/api/v1/businesses", optionalAuthMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const { city, category, search, page = "1", pageSize = "20" } = req.query;
      
      const businesses = await storage.getBusinesses({
        city: city as string | undefined,
        category: category as string | undefined,
        search: search as string | undefined,
      });
      
      const pageNum = parseInt(page as string, 10);
      const size = parseInt(pageSize as string, 10);
      const startIndex = (pageNum - 1) * size;
      const paginatedBusinesses = businesses.slice(startIndex, startIndex + size);
      
      res.json({ 
        success: true, 
        data: { businesses: paginatedBusinesses },
        meta: {
          page: pageNum,
          pageSize: size,
          total: businesses.length,
          totalPages: Math.ceil(businesses.length / size)
        }
      });
    } catch (error) {
      console.error("V1 Get businesses error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "FETCH_FAILED", message: "Failed to fetch businesses" }
      });
    }
  });
  
  // V1 Get Single Business (public)
  app.get("/api/v1/businesses/:id", async (req, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      
      if (!business) {
        return res.status(404).json({ 
          success: false, 
          error: { code: "NOT_FOUND", message: "Business not found" }
        });
      }
      
      res.json({ success: true, data: { business } });
    } catch (error) {
      console.error("V1 Get business error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "FETCH_FAILED", message: "Failed to fetch business" }
      });
    }
  });
  
  // V1 Update Business (requires Bearer token, vendor only)
  app.patch("/api/v1/businesses/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const business = await storage.getBusiness(req.params.id);
      
      if (!business) {
        return res.status(404).json({ 
          success: false, 
          error: { code: "NOT_FOUND", message: "Business not found" }
        });
      }
      
      if (business.ownerId !== req.user!.userId) {
        return res.status(403).json({ 
          success: false, 
          error: { code: "FORBIDDEN", message: "Not authorized to update this business" }
        });
      }
      
      const updated = await storage.updateBusiness(req.params.id, req.body);
      res.json({ success: true, data: { business: updated } });
    } catch (error) {
      console.error("V1 Update business error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "UPDATE_FAILED", message: "Failed to update business" }
      });
    }
  });
  
  // V1 Get Cities (public)
  app.get("/api/v1/cities", async (req, res) => {
    try {
      const cities = await storage.getCities();
      res.json({ 
        success: true, 
        data: { cities },
        meta: { total: cities.length }
      });
    } catch (error) {
      console.error("V1 Get cities error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "FETCH_FAILED", message: "Failed to fetch cities" }
      });
    }
  });
  
  // V1 Get Single City (public)
  app.get("/api/v1/cities/:id", async (req, res) => {
    try {
      const city = await storage.getCity(req.params.id);
      
      if (!city) {
        return res.status(404).json({ 
          success: false, 
          error: { code: "NOT_FOUND", message: "City not found" }
        });
      }
      
      res.json({ success: true, data: { city } });
    } catch (error) {
      console.error("V1 Get city error:", error);
      res.status(500).json({ 
        success: false, 
        error: { code: "FETCH_FAILED", message: "Failed to fetch city" }
      });
    }
  });

  return httpServer;
}
