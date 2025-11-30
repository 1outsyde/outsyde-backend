import { 
  type User, 
  type InsertUser, 
  type Business, 
  type InsertBusiness,
  type City,
  type InsertCity,
  users,
  businesses,
  cities
} from "@shared/schema";
import { db } from "./db";
import { eq, ilike, or, and, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  
  getBusiness(id: string): Promise<Business | undefined>;
  getBusinessByOwnerId(ownerId: string): Promise<Business | undefined>;
  getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]>;
  createBusiness(business: InsertBusiness): Promise<Business>;
  updateBusiness(id: string, updates: Partial<Business>): Promise<Business | undefined>;
  
  getCities(): Promise<City[]>;
  getCity(id: string): Promise<City | undefined>;
  createCity(city: InsertCity): Promise<City>;
  updateCityBusinessCount(cityId: string, count: number): Promise<void>;
  
  seedInitialData(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  
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

  async getBusiness(id: string): Promise<Business | undefined> {
    const result = await db.select().from(businesses).where(eq(businesses.id, id));
    return result[0];
  }

  async getBusinessByOwnerId(ownerId: string): Promise<Business | undefined> {
    const result = await db.select().from(businesses).where(eq(businesses.ownerId, ownerId));
    return result[0];
  }

  async getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]> {
    let conditions = [];
    
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
      const result = await db.insert(businesses).values({
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
