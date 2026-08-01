interface AuthenticatedUser {
    id: number;
    username: string;
}

export class AuthService {
    public async validateUser(username: string, password: string): Promise<AuthenticatedUser | null> {
        const configuredUsername = process.env.ADMIN_USERNAME;
        const configuredPassword = process.env.ADMIN_PASSWORD;

        if (!configuredUsername || !configuredPassword) {
            throw new Error('ADMIN_USERNAME und ADMIN_PASSWORD sind nicht konfiguriert.');
        }

        if (username === configuredUsername && password === configuredPassword) {
            return { id: 1, username };
        }

        return null;
    }
}