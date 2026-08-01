import { Request, Response, NextFunction } from 'express';

const ensureAuth = (req: Request, res: Response, next: NextFunction) => {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/login');
};

export default ensureAuth;