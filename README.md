# Bus Tracking Backend API

This is a Node.js backend for a bus tracking and management system using Express and Supabase.

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Set up your `.env` file** with your Supabase credentials:
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   PORT=3000
   ```
3. **Run the server:**
   ```bash
   npm run dev
   # or
   node src/server.js
   ```

## API Endpoints

### Authentication
- **POST** `/api/auth/signup` — Register a new user
- **POST** `/api/auth/login` — Log in a user

### Client
- **GET** `/api/client/bus-eta/:busId` — Get ETA and current location for a bus
- **POST** `/api/client/booking` — Book a seat for a user on a bus
- **POST** `/api/client/feedback` — Submit feedback for a bus

### Admin
- **PUT** `/api/admin/bus/:id/reassign` — Reassign driver, conductor, or route for a bus
- **GET** `/api/admin/transit-insights` — Get active buses with driver and conductor info
- **POST** `/api/admin/notification` — Send a notification to a user
- **POST** `/api/admin/terminal` — Add a new terminal
- **GET** `/api/admin/terminals` — List all terminals
- **POST** `/api/admin/route` — Add a new route (with stops)
- **GET** `/api/admin/routes` — List all routes (with stops)
- **POST** `/api/admin/bus` — Register a new bus
- **GET** `/api/admin/buses` — List all buses
- **GET** `/api/admin/bus-locations` — Get all buses with their current locations
- **GET** `/api/admin/users` — Get all users
- **GET** `/api/admin/users/clients` — Get only client users
- **GET** `/api/admin/users/employees` — Get only employee users

### Employee
- **POST** `/api/employee/report` — Employee submits a report about a bus
- **PUT** `/api/employee/passenger-count/:busId` — Update available seats (add/remove) for a bus

---

## Sample JSON Payloads

### 1. Register a User (Admin/Client/Employee)
**POST** `/api/auth/signup`
```json
{
  "email": "admin@example.com",
  "password": "yourStrongPassword123",
  "username": "adminuser",
  "role": "admin", // or "client" or "employee"
  "profile": {
    "fullName": "Admin User",
    "phone": "09171234567"
  }
}
```

### 2. Log In
**POST** `/api/auth/login`
```json
{
  "email": "admin@example.com",
  "password": "yourStrongPassword123"
}
```

### 3. Add Terminal
**POST** `/api/admin/terminal`
```json
{
  "name": "Cubao Terminal",
  "address": "EDSA corner Aurora Blvd, Cubao, Quezon City, Metro Manila, Philippines"
}
```

### 4. Add Route (with stops)
**POST** `/api/admin/route`
```json
{
  "name": "Cubao to PITX Route",
  "start_terminal_id": "UUID_OF_CUBAO_TERMINAL",
  "end_terminal_id": "UUID_OF_PITX_TERMINAL",
  "stops": [
    "UUID_OF_CUBAO_TERMINAL",
    "UUID_OF_PITX_TERMINAL"
  ]
}
```

### 5. Register a New Bus
**POST** `/api/admin/bus`
```json
{
  "bus_number": "PH-BUS-101",
  "total_seats": 50,
  "terminal_id": "UUID_OF_CUBAO_TERMINAL",
  "route_id": "UUID_OF_CUBAO_TO_PITX_ROUTE"
}
```

### 6. Book a Bus (Client)
**POST** `/api/client/booking`
```json
{
  "userId": "UUID_OF_CLIENT_USER",
  "busId": "UUID_OF_BUS"
}
```

### 7. Submit Feedback (Client)
**POST** `/api/client/feedback`
```json
{
  "userId": "UUID_OF_CLIENT_USER",
  "busId": "UUID_OF_BUS",
  "rating": 5,
  "comment": "Very comfortable ride!"
}
```

### 8. Employee Report
**POST** `/api/employee/report`
```json
{
  "employeeId": "UUID_OF_EMPLOYEE_USER",
  "busId": "UUID_OF_BUS",
  "type": "maintenance",
  "description": "Bus needs oil change."
}
```

### 9. Update Passenger Count (Employee)
**PUT** `/api/employee/passenger-count/UUID_OF_BUS`
```json
{
  "action": "add" // or "remove"
}
```

---

## Testing with Postman

1. **Import Endpoints:**
   - Use the endpoint URLs above in Postman.
2. **Set Method:**
   - Choose the correct HTTP method (GET, POST, PUT).
3. **Set Body:**
   - For POST/PUT, select `raw` and `JSON` in the Body tab.
   - Paste the sample JSON payload.
4. **Send Request:**
   - Click Send and view the response.
5. **Authentication:**
   - For protected endpoints, include the `access_token` in the `Authorization` header:
     ```
     Authorization: Bearer YOUR_ACCESS_TOKEN
     ```

---

## Notes
- Replace all `UUID_OF_...` placeholders with actual UUIDs from your database (use GET endpoints to fetch them).
- Make sure your server is running and your `.env` is configured.

---

For more details or troubleshooting, see the code or contact the maintainer. 