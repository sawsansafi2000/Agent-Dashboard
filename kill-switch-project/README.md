# Kill-Switch Project

## Overview
The Kill-Switch Project implements a mechanism to safely stop processes in an application. It uses a simple text file, `STOP.txt`, to signal whether the system should be active or inactive. This project is designed to ensure that critical operations can be halted quickly and safely in emergency situations.

## Components
- **STOP.txt**: A signal file that indicates the status of the Kill-Switch. It starts with "Status: INACTIVE" and can be changed to "ACTIVE" to trigger the emergency stop.
- **src/index.ts**: The main entry point of the application, responsible for initializing the server and configurations.
- **src/server.ts**: Sets up the server and handles incoming requests, integrating the Kill-Switch functionality.
- **src/kill-switch**: Contains the core functionality of the Kill-Switch mechanism, including:
  - **index.ts**: Exports the main Kill-Switch functionality.
  - **manager.ts**: Manages the state of the Kill-Switch and checks the status of `STOP.txt`.
  - **controller.ts**: Handles logic for stopping processes and committing the current state.
  - **store.ts**: Manages the storage and retrieval of the Kill-Switch state.
  - **types.ts**: Defines types and interfaces used in the Kill-Switch module.
- **src/api/routes.ts**: Defines API routes for the application, including endpoints that interact with the Kill-Switch.
- **src/cli/cli.ts**: Implements command-line interface functionality for user interaction with the Kill-Switch.
- **src/config/default.ts**: Contains default configuration settings for the application.
- **src/utils/logger.ts**: Provides logging utilities for tracking events and errors.

## Testing
The project includes unit and integration tests to ensure the Kill-Switch functionality works as intended:
- **test/unit/kill-switch.test.ts**: Unit tests for the Kill-Switch functionality.
- **test/integration/integration.test.ts**: Integration tests verifying interactions between the Kill-Switch and other components.

## Setup
1. Clone the repository.
2. Install dependencies using npm:
   ```
   npm install
   ```
3. Ensure `STOP.txt` is present in the root directory with the initial content "Status: INACTIVE".
4. Start the application:
   ```
   npm start
   ```

## Usage
To activate the Kill-Switch, change the content of `STOP.txt` to "Status: ACTIVE". The application will respond accordingly, halting operations as defined in the Kill-Switch logic.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.