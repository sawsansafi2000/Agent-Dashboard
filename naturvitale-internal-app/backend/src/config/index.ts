import dotenv from 'dotenv';

dotenv.config();

function requireEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not configured.`);
    }
    return value;
}

const config = {
    port: process.env.PORT || 3000,
    db: {
        url: process.env.DATABASE_URL || 'sqlite:./database.sqlite',
    },
    session: {
        secret: requireEnvironment('SESSION_SECRET'),
        resave: false,
        saveUninitialized: true,
    },
    admin: {
        email: requireEnvironment('ADMIN_EMAIL'),
        password: requireEnvironment('ADMIN_PASSWORD'),
    },
    socialMedia: {
        platforms: ['instagram', 'facebook', 'xing', 'tiktok', 'youtube'],
    },
};

export default config;