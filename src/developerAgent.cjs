'use strict';

const MAX_COMMAND_LENGTH = 4_000;

function requestError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function validateDeveloperTask(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw requestError(400, 'Ungültige lokale Task-Anfrage.');
    }

    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command || command.length > MAX_COMMAND_LENGTH) {
        throw requestError(400, `Der lokale Befehl muss zwischen 1 und ${MAX_COMMAND_LENGTH} Zeichen lang sein.`);
    }
    const draftMatch = command.match(/^\/local draft (?:development|marketing) -- ([\s\S]+)$/);
    if (draftMatch && (!draftMatch[1].trim() || draftMatch[1].trim().length > 500 || /[\u0000-\u001f\u007f]/.test(draftMatch[1].trim()))) {
        throw requestError(400, 'Das Entwurfsthema muss 1 bis 500 Zeichen ohne Steuerzeichen enthalten.');
    }
    const supportedCommand = command === '/local status'
        || Boolean(draftMatch)
        || /^\/local (?:list|read) [^\s]+$/.test(command)
        || /^\/local write [^\s]+ -- [\s\S]*$/.test(command);
    if (!supportedCommand) {
        throw requestError(400, 'Unterstützt werden nur /local status, draft, list, read und write-Befehle.');
    }

    return { command };
}

async function submitDeveloperTask(input, submitTask) {
    const { command } = validateDeveloperTask(input);
    if (typeof submitTask !== 'function') {
        throw requestError(503, 'Die native lokale Task-Queue ist nicht verfügbar.');
    }
    return submitTask(command);
}

module.exports = {
    submitDeveloperTask,
    validateDeveloperTask,
};
