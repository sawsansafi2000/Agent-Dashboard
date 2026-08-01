import { Session } from '../models/session.model'; // Assuming a session model exists
import { v4 as uuidv4 } from 'uuid'; // For generating unique session IDs
import { Database } from '../db'; // Assuming a database connection module

class SessionService {
    private db: Database;

    constructor() {
        this.db = new Database(); // Initialize the database connection
    }

    // Create a new session
    public async createSession(userId: string): Promise<string> {
        const sessionId = uuidv4(); // Generate a unique session ID
        const session: Session = {
            id: sessionId,
            userId: userId,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        await this.db.saveSession(session); // Save the session to the database
        return sessionId;
    }

    // Validate an existing session
    public async validateSession(sessionId: string): Promise<boolean> {
        const session = await this.db.getSession(sessionId); // Retrieve the session from the database
        return session !== null; // Return true if the session exists
    }

    // End a session
    public async endSession(sessionId: string): Promise<void> {
        await this.db.deleteSession(sessionId); // Delete the session from the database
    }
}

export default new SessionService();