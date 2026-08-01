import session from 'express-session';
import SQLiteStore from 'connect-sqlite3';

const SQLiteStoreSession = SQLiteStore(session);
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
    throw new Error('SESSION_SECRET ist nicht konfiguriert.');
}

const sessionMiddleware = session({
    store: new SQLiteStoreSession({
        db: 'sessions.db',
        dir: './src/db/migrations',
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 60 * 1000 // 30 minutes
    }
});

export default sessionMiddleware;