import fs from 'fs';

const logFilePath = 'application.log';

export function logInfo(message: string) {
    const logMessage = `[INFO] ${new Date().toISOString()}: ${message}\n`;
    fs.appendFileSync(logFilePath, logMessage);
}

export function logError(message: string) {
    const logMessage = `[ERROR] ${new Date().toISOString()}: ${message}\n`;
    fs.appendFileSync(logFilePath, logMessage);
}

export function logWarning(message: string) {
    const logMessage = `[WARNING] ${new Date().toISOString()}: ${message}\n`;
    fs.appendFileSync(logFilePath, logMessage);
}