import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

function equal(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isDashboardAuthorizationValid(authorization?: string): boolean {
    const username = process.env.DASHBOARD_USERNAME;
    const password = process.env.DASHBOARD_PASSWORD;
    if (!username || !password) return false;
    const encoded = authorization?.startsWith('Basic ') ? authorization.slice(6) : '';
    const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const separator = decoded.indexOf(':');
    const suppliedUsername = separator >= 0 ? decoded.slice(0, separator) : '';
    const suppliedPassword = separator >= 0 ? decoded.slice(separator + 1) : '';
    return equal(suppliedUsername, username) && equal(suppliedPassword, password);
}

export function requireDashboardAccess(req: Request, res: Response, next: NextFunction): void {
    const publicPath = req.path === '/'
        || req.path === '/health'
        || req.path === '/offers'
        || req.path.startsWith('/offers/')
        || req.path.startsWith('/css/');

    if (publicPath) {
        next();
        return;
    }

    if (!process.env.DASHBOARD_USERNAME || !process.env.DASHBOARD_PASSWORD) {
        res.status(503).send('Dashboard-Zugang ist nicht konfiguriert.');
        return;
    }

    if (!isDashboardAuthorizationValid(req.get('authorization'))) {
        res.setHeader('WWW-Authenticate', 'Basic realm="NV Agent Operations", charset="UTF-8"');
        res.status(401).send('Anmeldung erforderlich.');
        return;
    }
    next();
}