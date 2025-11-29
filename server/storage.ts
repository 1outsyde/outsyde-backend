import { 
  type User, 
  type InsertUser, 
  type Business, 
  type InsertBusiness,
  type City,
  type InsertCity 
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  
  // Businesses
  getBusiness(id: string): Promise<Business | undefined>;
  getBusinessByOwnerId(ownerId: string): Promise<Business | undefined>;
  getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]>;
  createBusiness(business: InsertBusiness): Promise<Business>;
  updateBusiness(id: string, updates: Partial<Business>): Promise<Business | undefined>;
  
  // Cities
  getCities(): Promise<City[]>;
  getCity(id: string): Promise<City | undefined>;
  createCity(city: InsertCity): Promise<City>;
  updateCityBusinessCount(cityId: string, count: number): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private businesses: Map<string, Business>;
  private cities: Map<string, City>;

  constructor() {
    this.users = new Map();
    this.businesses = new Map();
    this.cities = new Map();
    
    // Seed major cities
    this.seedCities();
    // Seed sample businesses for demo
    this.seedBusinesses();
  }

  private seedCities() {
    const majorCities: City[] = [
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
    
    majorCities.forEach(city => this.cities.set(city.id, city));
  }

  private seedBusinesses() {
    const sampleBusinesses: Business[] = [
      {
        id: "b1",
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
        coverImage: null,
        logoImage: null,
        rating: 48,
        reviewCount: 124,
        subscriptionActive: true,
      },
      {
        id: "b2",
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
        websiteUrl: null,
        socialMedia: "@bellashair",
        coverImage: null,
        logoImage: null,
        rating: 49,
        reviewCount: 89,
        subscriptionActive: true,
      },
      {
        id: "b3",
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
        coverImage: null,
        logoImage: null,
        rating: 47,
        reviewCount: 56,
        subscriptionActive: true,
      },
      {
        id: "b4",
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
        coverImage: null,
        logoImage: null,
        rating: 49,
        reviewCount: 203,
        subscriptionActive: true,
      },
      {
        id: "b5",
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
        websiteUrl: null,
        socialMedia: "@greenvalleyorganics",
        coverImage: null,
        logoImage: null,
        rating: 48,
        reviewCount: 167,
        subscriptionActive: true,
      },
      {
        id: "b6",
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
        websiteUrl: null,
        socialMedia: "@urbancuts",
        coverImage: null,
        logoImage: null,
        rating: 46,
        reviewCount: 78,
        subscriptionActive: true,
      },
      {
        id: "b7",
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
        coverImage: null,
        logoImage: null,
        rating: 49,
        reviewCount: 312,
        subscriptionActive: true,
      },
      {
        id: "b8",
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
        coverImage: null,
        logoImage: null,
        rating: 47,
        reviewCount: 145,
        subscriptionActive: true,
      },
    ];
    
    sampleBusinesses.forEach(business => this.businesses.set(business.id, business));
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { 
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
    };
    this.users.set(id, user);
    return user;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const user = this.users.get(id);
    if (!user) return undefined;
    const updated = { ...user, ...updates };
    this.users.set(id, updated);
    return updated;
  }

  // Business methods
  async getBusiness(id: string): Promise<Business | undefined> {
    return this.businesses.get(id);
  }

  async getBusinessByOwnerId(ownerId: string): Promise<Business | undefined> {
    return Array.from(this.businesses.values()).find(
      (business) => business.ownerId === ownerId,
    );
  }

  async getBusinesses(filters?: { city?: string; category?: string; search?: string }): Promise<Business[]> {
    let businesses = Array.from(this.businesses.values());
    
    if (filters?.city) {
      businesses = businesses.filter(b => b.city?.toLowerCase() === filters.city?.toLowerCase());
    }
    
    if (filters?.category && filters.category !== "All") {
      businesses = businesses.filter(b => b.category === filters.category);
    }
    
    if (filters?.search) {
      const search = filters.search.toLowerCase();
      businesses = businesses.filter(b => 
        b.name.toLowerCase().includes(search) || 
        b.description?.toLowerCase().includes(search)
      );
    }
    
    return businesses;
  }

  async createBusiness(insertBusiness: InsertBusiness): Promise<Business> {
    const id = randomUUID();
    const business: Business = {
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
    };
    this.businesses.set(id, business);
    
    // Update city business count
    if (business.city) {
      const city = this.cities.get(business.city);
      if (city) {
        city.businessCount = (city.businessCount || 0) + 1;
        this.cities.set(city.id, city);
      }
    }
    
    return business;
  }

  async updateBusiness(id: string, updates: Partial<Business>): Promise<Business | undefined> {
    const business = this.businesses.get(id);
    if (!business) return undefined;
    const updated = { ...business, ...updates };
    this.businesses.set(id, updated);
    return updated;
  }

  // City methods
  async getCities(): Promise<City[]> {
    return Array.from(this.cities.values());
  }

  async getCity(id: string): Promise<City | undefined> {
    return this.cities.get(id);
  }

  async createCity(city: InsertCity): Promise<City> {
    const newCity: City = {
      id: city.id,
      name: city.name,
      state: city.state,
      businessCount: city.businessCount ?? 0,
      imageUrl: city.imageUrl || null,
      trending: city.trending ?? false,
    };
    this.cities.set(newCity.id, newCity);
    return newCity;
  }

  async updateCityBusinessCount(cityId: string, count: number): Promise<void> {
    const city = this.cities.get(cityId);
    if (city) {
      city.businessCount = count;
      this.cities.set(cityId, city);
    }
  }
}

export const storage = new MemStorage();
