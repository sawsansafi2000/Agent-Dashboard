# NaturVitale Internal Application

## Overview
The NaturVitale Internal Application is designed to provide a secure and efficient platform for managing user authentication, admin functionalities, and real-time updates across various social media platforms. This application is built using TypeScript, Express for the backend, and React for the frontend.

## Project Structure
The project is organized into the following main directories:

- **backend**: Contains the server-side code, including API routes, controllers, services, and database management.
- **frontend**: Contains the client-side code, including React components, pages, and services for API interaction.
- **scripts**: Contains utility scripts for database initialization and seeding.
- **docker-compose.yml**: Configuration for running the application in a Docker environment.
- **.env.example**: Example environment variables for configuration.

## Features
- Secure user authentication with role-based access control.
- Admin dashboard for managing users and monitoring activity.
- Real-time updates for active agents and system status.
- Integration with social media platforms: Instagram, Facebook, Xing, TikTok, and YouTube.

## Getting Started

### Prerequisites
- Node.js
- TypeScript
- Docker (optional, for containerized deployment)

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
   cd frontend
   npm install
   ```

### Configuration
- Copy the `.env.example` files in both the `backend` and `frontend` directories to `.env` and update the environment variables as needed.

### Running the Application
1. Start the backend server:
   ```
   cd backend
   npm run start
   ```

2. Start the frontend application:
   ```
   cd frontend
   npm run start
   ```

3. Optionally, run the application using Docker:
   ```
   docker-compose up
   ```

### Database Setup
- Run the database initialization script:
   ```
   cd scripts
   ts-node init-db.ts
   ```

- Seed the admin user:
   ```
   ts-node seed-admin.ts
   ```

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License
This project is licensed under the MIT License. See the LICENSE file for details.