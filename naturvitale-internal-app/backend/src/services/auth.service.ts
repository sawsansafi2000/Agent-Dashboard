import { hash, compare } from 'bcrypt';
import { User } from '../models/user.model';
import { SessionService } from './session.service';

class AuthService {
    private sessionService: SessionService;

    constructor() {
        this.sessionService = new SessionService();
    }

    async register(email: string, password: string): Promise<User> {
        const hashedPassword = await this.hashPassword(password);
        const newUser = new User({ email, password: hashedPassword });
        return await newUser.save();
    }

    async login(email: string, password: string): Promise<string | null> {
        const user = await User.findOne({ email });
        if (user && await this.comparePassword(password, user.password)) {
            return this.sessionService.createSession(user);
        }
        return null;
    }

    private async hashPassword(password: string): Promise<string> {
        const saltRounds = 10;
        return await hash(password, saltRounds);
    }

    private async comparePassword(password: string, hashedPassword: string): Promise<boolean> {
        return await compare(password, hashedPassword);
    }
}

export default new AuthService();