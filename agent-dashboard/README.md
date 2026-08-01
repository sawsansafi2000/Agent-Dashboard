# Agent Dashboard

## Overview
The Agent Dashboard is a web application designed to monitor the status and progress of agents in real-time. It provides a user-friendly interface for logging in and viewing active agents, along with their current progress.

## Features
- User authentication with login/logout functionality.
- Real-time updates on agent status and progress every 5 minutes.
- Dashboard view displaying active agents and their details.

## Project Structure
```
agent-dashboard
├── src
│   ├── app.ts
│   ├── server.ts
│   ├── controllers
│   │   ├── authController.ts
│   │   └── dashboardController.ts
│   ├── routes
│   │   ├── auth.ts
│   │   └── dashboard.ts
│   ├── models
│   │   ├── user.ts
│   │   └── agent.ts
│   ├── db
│   │   ├── index.ts
│   │   └── migrations
│   │       └── 001-init.sql
│   ├── services
│   │   ├── authService.ts
│   │   └── agentService.ts
│   ├── middleware
│   │   ├── session.ts
│   │   └── ensureAuth.ts
│   ├── sockets
│   │   └── index.ts
│   ├── public
│   │   ├── js
│   │   │   └── dashboard.js
│   │   └── css
│   │       └── styles.css
│   └── views
│       ├── layout.ejs
│       ├── login.ejs
│       └── dashboard.ejs
├── package.json
├── tsconfig.json
├── .env
├── .gitignore
└── README.md
```

## Installation
1. Clone the repository:
   ```
   git clone <repository-url>
   ```
2. Navigate to the project directory:
   ```
   cd agent-dashboard
   ```
3. Install the dependencies:
   ```
   npm install
   ```
4. Set up the environment variables in the `.env` file.

## Usage
1. Start the server:
   ```
   npm start
   ```
2. Open your browser and navigate to `http://localhost:3000` to access the application.

## License
This project is licensed under the MIT License.