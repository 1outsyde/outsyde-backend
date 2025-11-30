# Outsyde Mobile API Documentation

## Overview

The Outsyde mobile API uses JWT (JSON Web Token) authentication for secure, stateless communication with native mobile applications. All mobile endpoints are prefixed with `/api/v1/`.

## Base URL

```
Development: https://your-repl-url.replit.app/api/v1
Production: https://your-production-url.com/api/v1
```

## Authentication Flow

### 1. Registration

**Customer Registration**
```
POST /api/v1/auth/customer/signup
Content-Type: application/json

{
  "email": "customer@example.com",
  "password": "securePassword123",
  "name": "John Doe",
  "phone": "555-1234",
  "address": "123 Main St",
  "city": "New York",
  "state": "NY",
  "zipCode": "10001",
  "ageRange": "25-34",
  "gender": "male",
  "ethnicity": "prefer-not-to-say",
  "nationality": "american",
  "householdSize": "2",
  "incomeRange": "50000-75000",
  "education": "bachelors",
  "occupation": "Software Developer",
  "selectedIndustries": ["technology", "food"],
  "industryNiches": {
    "technology": ["mobile-apps", "software"],
    "food": ["restaurants", "cafes"]
  }
}
```

**Vendor Registration**
```
POST /api/v1/auth/vendor/signup
Content-Type: application/json

{
  "email": "vendor@example.com",
  "password": "securePassword123",
  "name": "Jane Smith",
  "phone": "555-5678",
  "businessName": "Jane's Bakery",
  "category": "Food & Dining",
  "description": "Artisan baked goods and pastries",
  "isStartup": true,
  "yearsInBusiness": 2,
  "numberOfEmployees": "1-5",
  "businessStructure": "LLC",
  "hasPhysicalLocation": true,
  "address": "456 Baker St",
  "city": "New York",
  "state": "NY",
  "zipCode": "10002",
  "websiteUrl": "https://janesbakery.com",
  "socialMedia": {
    "instagram": "@janesbakery",
    "facebook": "janesbakerynyc"
  },
  "subscriptionAcknowledged": true
}
```

**Response (Both)**
```json
{
  "user": {
    "id": "uuid-string",
    "email": "user@example.com",
    "name": "User Name",
    "isVendor": false
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

### 2. Login

```
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securePassword123"
}
```

**Response**
```json
{
  "user": {
    "id": "uuid-string",
    "email": "user@example.com",
    "name": "User Name",
    "isVendor": false
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

### 3. Token Refresh

Access tokens expire after 1 hour. Use the refresh token to obtain new tokens:

```
POST /api/v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

### 4. Get Current User

```
GET /api/v1/auth/me
Authorization: Bearer <accessToken>
```

**Response**
```json
{
  "id": "uuid-string",
  "email": "user@example.com",
  "name": "User Name",
  "isVendor": false,
  "phone": "555-1234",
  "city": "New York",
  "state": "NY"
}
```

## Using Protected Endpoints

All protected endpoints require the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## Businesses API

### List Businesses

```
GET /api/v1/businesses
GET /api/v1/businesses?cityId=nyc
GET /api/v1/businesses?category=Food%20%26%20Dining
GET /api/v1/businesses?search=bakery
```

**Response**
```json
[
  {
    "id": "uuid-string",
    "ownerId": "owner-uuid",
    "name": "Jane's Bakery",
    "category": "Food & Dining",
    "description": "Artisan baked goods",
    "city": "New York",
    "state": "NY",
    "rating": 4.8,
    "reviewCount": 127,
    "imageUrl": "https://..."
  }
]
```

### Get Single Business

```
GET /api/v1/businesses/:id
```

### Update Business (Vendor Only)

```
PATCH /api/v1/businesses/:id
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "description": "Updated description",
  "websiteUrl": "https://newsite.com"
}
```

## Cities API

### List Cities

```
GET /api/v1/cities
```

**Response**
```json
[
  {
    "id": "nyc",
    "name": "New York City",
    "state": "NY",
    "businessCount": 1250,
    "imageUrl": "https://...",
    "trending": true
  }
]
```

### Get Single City

```
GET /api/v1/cities/:id
```

## User Preferences API

### Update Preferences

```
PATCH /api/v1/users/preferences
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "selectedIndustries": ["technology", "food", "wellness"],
  "industryNiches": {
    "technology": ["mobile-apps"],
    "food": ["cafes", "bakeries"],
    "wellness": ["yoga", "meditation"]
  }
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### Common HTTP Status Codes

| Code | Description |
|------|-------------|
| 200  | Success |
| 201  | Created (signup) |
| 400  | Bad Request (validation error) |
| 401  | Unauthorized (missing or invalid token) |
| 403  | Forbidden (not allowed to access resource) |
| 404  | Not Found |
| 500  | Internal Server Error |

## Token Expiration

| Token Type | Expiration |
|------------|------------|
| Access Token | 1 hour |
| Refresh Token | 7 days |

## Token Security

### Token Rotation
When you call `/api/v1/auth/refresh`, the system:
1. Validates your current refresh token against the database
2. Revokes the old refresh token immediately
3. Issues new access and refresh tokens
4. Stores the new refresh token securely

This means each refresh token can only be used once. If a refresh token has already been used, subsequent attempts will fail with a `TOKEN_REVOKED` error.

### Session Invalidation
- Each refresh token is stored in the database with a hash
- When a user logs out from one device, they can revoke all sessions by calling the logout endpoint
- Compromised tokens can be immediately invalidated

### Web vs Mobile Authentication
The Outsyde API provides two authentication methods:

| Endpoint Prefix | Auth Type | Use Case |
|-----------------|-----------|----------|
| `/api/` | Session cookies (httpOnly) | Web browsers |
| `/api/v1/` | JWT Bearer tokens | Mobile apps |

**Important**: Mobile apps should only use `/api/v1/` endpoints. The session-based `/api/` endpoints will not work properly with native mobile apps.

## Mobile Implementation Examples

### Swift (iOS)

```swift
import Foundation

class OutsydeAPI {
    static let shared = OutsydeAPI()
    private let baseURL = "https://your-app.replit.app/api/v1"
    private var accessToken: String?
    private var refreshToken: String?
    
    func login(email: String, password: String) async throws -> User {
        let url = URL(string: "\(baseURL)/auth/login")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body = ["email": email, "password": password]
        request.httpBody = try JSONEncoder().encode(body)
        
        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(AuthResponse.self, from: data)
        
        self.accessToken = response.accessToken
        self.refreshToken = response.refreshToken
        
        return response.user
    }
    
    func getBusinesses(cityId: String? = nil) async throws -> [Business] {
        var urlString = "\(baseURL)/businesses"
        if let cityId = cityId {
            urlString += "?cityId=\(cityId)"
        }
        
        let url = URL(string: urlString)!
        var request = URLRequest(url: url)
        
        if let token = accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONDecoder().decode([Business].self, from: data)
    }
}
```

### Kotlin (Android)

```kotlin
import retrofit2.Retrofit
import retrofit2.http.*

interface OutsydeApi {
    @POST("auth/login")
    suspend fun login(@Body credentials: LoginRequest): AuthResponse
    
    @GET("businesses")
    suspend fun getBusinesses(
        @Header("Authorization") token: String,
        @Query("cityId") cityId: String? = null
    ): List<Business>
    
    @POST("auth/refresh")
    suspend fun refreshToken(@Body request: RefreshRequest): TokenResponse
}

class OutsydeRepository(private val api: OutsydeApi) {
    private var accessToken: String? = null
    private var refreshToken: String? = null
    
    suspend fun login(email: String, password: String): User {
        val response = api.login(LoginRequest(email, password))
        accessToken = response.accessToken
        refreshToken = response.refreshToken
        return response.user
    }
    
    suspend fun getBusinesses(cityId: String? = null): List<Business> {
        val token = accessToken ?: throw UnauthorizedException()
        return api.getBusinesses("Bearer $token", cityId)
    }
}
```

### React Native

```javascript
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = 'https://your-app.replit.app/api/v1';

class OutsydeAPI {
  async getToken() {
    return AsyncStorage.getItem('accessToken');
  }

  async setTokens(accessToken, refreshToken) {
    await AsyncStorage.setItem('accessToken', accessToken);
    await AsyncStorage.setItem('refreshToken', refreshToken);
  }

  async login(email, password) {
    const response = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    
    await this.setTokens(data.accessToken, data.refreshToken);
    return data.user;
  }

  async getBusinesses(cityId = null) {
    const token = await this.getToken();
    const url = cityId 
      ? `${BASE_URL}/businesses?cityId=${cityId}`
      : `${BASE_URL}/businesses`;
    
    const response = await fetch(url, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
    
    return response.json();
  }

  async refreshTokens() {
    const refreshToken = await AsyncStorage.getItem('refreshToken');
    if (!refreshToken) throw new Error('No refresh token');
    
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    
    await this.setTokens(data.accessToken, data.refreshToken);
    return data;
  }
}

export default new OutsydeAPI();
```

## Security Best Practices

1. **Store tokens securely** - Use Keychain (iOS), EncryptedSharedPreferences (Android), or secure storage solutions
2. **Implement token refresh** - Refresh access tokens before they expire
3. **Handle 401 errors** - Automatically attempt token refresh on 401 responses
4. **Clear tokens on logout** - Remove all stored tokens when user logs out
5. **Use HTTPS** - All API calls should use HTTPS in production

## Rate Limiting

The API implements rate limiting to prevent abuse:
- 100 requests per minute for authenticated users
- 20 requests per minute for unauthenticated users

When rate limited, you'll receive a 429 status code.

## Need Help?

For API support, contact the Outsyde development team.
