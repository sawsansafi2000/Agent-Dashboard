# Naturvitale Internal App

## Overview
The Naturvitale Internal App is designed to provide a secure and efficient platform for managing user authentication, social media integrations, and real-time updates. This application consists of a backend built with TypeScript and Express, and a frontend developed using React.

## Project Structure
The project is organized into the following main directories:

- **backend**: Contains the server-side code, including routes, controllers, services, and database management.
- **frontend**: Contains the client-side code, including React components, pages, and services.
- **scripts**: Contains scripts for database initialization and seeding.
- **docker-compose.yml**: Configuration for running the application in Docker.
- **.env.example**: Example environment variables for the application.
- **README.md**: Documentation for the overall project.

## Getting Started

### Prerequisites
- Node.js (version 14 or higher)
- npm (Node Package Manager)
- Docker (for containerized deployment)

### Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/naturvitale-internal-app.git
   cd naturvitale-internal-app
   ```

2. Install backend dependencies:
   ```
   cd backend
   npm install
   ```

3. Install frontend dependencies:
   ```
   cd ../frontend
   npm install
   ```

### Configuration
- Copy the `.env.example` files in both the `backend` and `frontend` directories to `.env` and fill in the required environment variables.

### Running the Application

#### Backend
1. Start the backend server:
   ```
   cd backend
   npm run start
   ```

#### Frontend
1. Start the frontend application:
   ```
   cd frontend
   npm run start
   ```

### Database Setup
To initialize the database and seed the admin user, run the following commands:
```
cd scripts
npm run init-db
npm run seed-admin
```

### Real-Time Updates
The application features a real-time dashboard that updates automatically to reflect the current status of agents and completed tasks. The dashboard refreshes every 5 minutes or can be set to live-update based on your configuration.

## Contributing
Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.