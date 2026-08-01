import { Request, Response } from 'express';
import { AuthService } from '../services/authService';

export class AuthController {
    private authService: AuthService;

    constructor() {
        this.authService = new AuthService();
    }

    public login = async (req: Request, res: Response): Promise<void> => {
        const { username, password } = req.body;
        try {
            const user = await this.authService.validateUser(username, password);
            if (user) {
                req.session.userId = user.id;
                res.redirect('/dashboard');
            } else {
                res.status(401).send('Invalid credentials');
            }
        } catch (error) {
            res.status(500).send('Server error');
        }
    };

    public logout = (req: Request, res: Response): void => {
        req.session.destroy(err => {
            if (err) {
                return res.status(500).send('Could not log out');
            }
            res.redirect('/login');
        });
    };
}