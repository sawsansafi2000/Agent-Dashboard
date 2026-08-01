export const config = {
    stopFilePath: './STOP.txt',
    defaultStatus: 'INACTIVE',
    activeStatus: 'ACTIVE',
    logFilePath: './logs/app.log',
    serverPort: 3000,
    environment: process.env.NODE_ENV || 'development',
};