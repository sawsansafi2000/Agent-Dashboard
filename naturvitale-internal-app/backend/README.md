# Backend Application for Naturvitale Internal App

This README file provides an overview of the backend application for the Naturvitale Internal App. The backend is built using Node.js and TypeScript, utilizing Express for handling HTTP requests and SQLite for data storage.

## Project Structure

The backend project is organized as follows:

```
backend
├── src
│   ├── app.ts                # Initializes the Express application and sets up middleware
│   ├── server.ts             # Starts the server and listens for incoming requests
│   ├── config
│   │   └── index.ts          # Contains configuration settings for the application
│   ├── controllers
│   │   ├── auth.controller.ts # Handles authentication-related requests
│   │   └── admin.controller.ts # Handles admin-specific actions
│   ├── routes
│   │   └── index.ts          # Sets up application routes
│   ├── services
│   │   ├── auth.service.ts    # Logic for user authentication
│   │   ├── session.service.ts  # Manages user sessions
│   │   └── social
│   │       ├── instagram.service.ts # Interacts with the Instagram API
│   │       ├── facebook.service.ts   # Interacts with the Facebook API
│   │       ├── xing.service.ts       # Interacts with the Xing API
│   │       ├── tiktok.service.ts     # Interacts with the TikTok API
│   │       └── youtube.service.ts    # Interacts with the YouTube API
│   ├── db
│   │   ├── index.ts            # Initializes the database connection
│   │   ├── migrations
│   │   │   └── 001_init.sql    # Initial database schema setup
│   │   └── seeds
│   │       └── seed-admin.ts   # Seeds the database with initial admin user data
│   ├── models
│   │   └── user.model.ts       # Defines the user model
│   ├── middlewares
│   │   └── auth.middleware.ts   # Middleware for protecting routes
│   └── utils
│       └── realtime.ts         # Utility functions for real-time updates
├── package.json                # Lists backend dependencies and scripts
├── tsconfig.json               # TypeScript configuration settings
├── .env.example                # Example of environment variables needed for the backend
└── README.md                   # Documentation for the backend application
```

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/naturvitale-internal-app.git
   cd naturvitale-internal-app/backend
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Set up the environment variables by copying the `.env.example` file to `.env` and updating the values as necessary.

## Running the Application

To start the backend server, run:
```
npm start
```

The server will listen for incoming requests on the specified port (default is 3000).

## API Documentation

Refer to the individual controller files for details on the available API endpoints and their usage.

## Contributing

Contributions are welcome! Please submit a pull request or open an issue for any suggestions or improvements.

## License

This project is licensed under the MIT License. See the LICENSE file for details.