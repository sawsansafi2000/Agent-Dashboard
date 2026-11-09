import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 500;
const READABLE_AREAS = new Set(['agent-input', 'agent-output', 'reports']);

export type LocalTaskAction =
    | { operation: 'status' }
    | { operation: 'draft'; kind: 'development' | 'marketing'; topic: string }
    | { operation: 'list'; path: string }
    | { operation: 'read'; path: string }
    | { operation: 'write'; path: string; content: string };

export class LocalTaskInputError extends Error {}

export function parseLocalTaskCommand(message: string): LocalTaskAction {
    if (message === '/local status') return { operation: 'status' };

    const draftMatch = message.match(/^\/local draft (development|marketing) -- ([\s\S]+)$/);
    if (draftMatch) {
        const topic = draftMatch[2].trim();
        if (!topic || topic.length > 500 || /[\u0000-\u001f\u007f]/.test(topic)) {
            throw new LocalTaskInputError('Das Entwurfsthema muss 1 bis 500 Zeichen ohne Steuerzeichen enthalten.');
        }
        return { operation: 'draft', kind: draftMatch[1] === 'development' ? 'development' : 'marketing', topic };
    }

    const listMatch = message.match(/^\/local list ([^\s]+)$/);
    if (listMatch) return { operation: 'list', path: validateRelativePath(listMatch[1]) };

    const readMatch = message.match(/^\/local read ([^\s]+)$/);
    if (readMatch) {
        const relativePath = validateRelativePath(readMatch[1]);
        assertReadablePath(relativePath);
        return { operation: 'read', path: relativePath };
    }

    const writeMatch = message.match(/^\/local write ([^\s]+) -- ([\s\S]*)$/);
    if (writeMatch) {
        const relativePath = validateRelativePath(writeMatch[1]);
        if (!relativePath.startsWith('agent-output/')) {
            throw new LocalTaskInputError('Schreiben ist ausschließlich unter agent-output/ erlaubt.');
        }
        const content = writeMatch[2];
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
            throw new LocalTaskInputError(`Der Schreibinhalt darf maximal ${MAX_FILE_BYTES} Bytes groß sein.`);
        }
        return { operation: 'write', path: relativePath, content };
    }

    throw new LocalTaskInputError(
        'Lokaler Modus unterstützt nur: /local status, /local draft <development|marketing> -- <thema>, '
        + '/local list <agent-input|agent-output|reports>, '
        + '/local read <freigegebener-pfad> und /local write agent-output/<datei> -- <text>. '
        + 'Es werden weder Shell-Befehle noch beliebige Codeausführung unterstützt.',
    );
}

export async function executeLocalTaskCommand(message: string, workspaceRoot: string): Promise<Record<string, unknown>> {
    const action = parseLocalTaskCommand(message);
    if (action.operation === 'status') {
        return {
            mode: 'local-deterministic',
            externalModelCalls: false,
            tokenUsage: 0,
            processId: process.pid,
            uptimeSeconds: Math.floor(process.uptime()),
            checkedAt: new Date().toISOString(),
        };
    }

    if (action.operation === 'draft') {
        const steps = action.kind === 'development'
            ? [
                'Anforderungen und betroffene Komponenten für das Thema prüfen.',
                'Eine begrenzte Änderung in einer isolierten Arbeitsumgebung vorbereiten.',
                'Passende Tests für Funktion, Fehlerfälle und bestehendes Verhalten ausführen.',
                'Ergebnis und Risiken prüfen; Live-Übernahme nur nach gesonderter Freigabe.',
            ]
            : [
                'Zielgruppe und konkreten Nutzen anhand belegbarer Fakten definieren.',
                'Aussagen, Rechte und Plattformregeln vor einer Veröffentlichung prüfen.',
                'Nur mit ausdrücklicher Freigabe und auf einem erlaubten Kanal veröffentlichen.',
            ];
        return {
            operation: 'draft',
            kind: action.kind,
            topic: action.topic,
            generatedBy: 'local-template',
            externalModelCalls: false,
            published: false,
            executed: false,
            steps,
            ...(action.kind === 'marketing' ? {
                copyTemplate: `Thema: ${action.topic}\n\n[Belegbaren Nutzen und Zielgruppe ergänzen.]\n\n[Passende Handlungsaufforderung ergänzen.]`,
            } : {}),
            notice: 'Regelbasierte Vorlage, kein KI-Ergebnis. Es wurden keine externen Aktionen ausgeführt.',
        };
    }

    if (action.operation === 'list') {
        const directory = await resolveSafePath(workspaceRoot, action.path, 'directory');
        const handle = await fs.opendir(directory);
        const visibleEntries: Array<{ name: string; type: 'directory' | 'file' }> = [];
        let truncated = false;
        for await (const entry of handle) {
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
            if (visibleEntries.length === MAX_LIST_ENTRIES) {
                truncated = true;
                break;
            }
            visibleEntries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
        }
        return { operation: 'list', path: action.path, entries: visibleEntries, truncated };
    }

    if (action.operation === 'read') {
        const filePath = await resolveSafePath(workspaceRoot, action.path, 'file');
        const info = await fs.stat(filePath);
        if (info.size > MAX_FILE_BYTES) {
            throw new Error(`Datei überschreitet das Leselimit von ${MAX_FILE_BYTES} Bytes.`);
        }
        const contents = await fs.readFile(filePath);
        if (contents.byteLength > MAX_FILE_BYTES) {
            throw new Error(`Datei überschreitet das Leselimit von ${MAX_FILE_BYTES} Bytes.`);
        }
        return { operation: 'read', path: action.path, content: contents.toString('utf8') };
    }

    const filePath = await resolveSafePath(workspaceRoot, action.path, 'new-file');
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const contents = Buffer.from(action.content, 'utf8');
    try {
        const handle = await fs.open(temporaryPath, 'wx', 0o600);
        try {
            await handle.writeFile(contents);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.link(temporaryPath, filePath);
        return {
            operation: 'write',
            path: action.path,
            bytesWritten: contents.byteLength,
            sha256: createHash('sha256').update(contents).digest('hex'),
        };
    } finally {
        await fs.rm(temporaryPath, { force: true });
    }
}

function validateRelativePath(value: string): string {
    if (!value || value.includes('\\') || value.includes(':') || value.includes('\0') || value.startsWith('/')) {
        throw new LocalTaskInputError('Der Pfad muss relativ sein und darf keine Backslashes, Laufwerke oder NUL-Zeichen enthalten.');
    }
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
        throw new LocalTaskInputError('Leere, versteckte und übergeordnete Pfadsegmente sind nicht erlaubt.');
    }
    if (!READABLE_AREAS.has(parts[0]) || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
        throw new LocalTaskInputError('Der Pfad liegt außerhalb der freigegebenen lokalen Datenbereiche.');
    }
    return parts.join('/');
}

function assertReadablePath(relativePath: string): void {
    if (!relativePath.includes('/')) {
        throw new LocalTaskInputError('Lesezugriff benötigt einen Dateipfad innerhalb eines freigegebenen Datenbereichs.');
    }
}

async function resolveSafePath(
    workspaceRoot: string,
    relativePath: string,
    finalKind: 'directory' | 'file' | 'new-file',
): Promise<string> {
    const root = await fs.realpath(workspaceRoot);
    const segments = relativePath.split('/');
    const area = segments[0];
    if (!READABLE_AREAS.has(area)) throw new LocalTaskInputError('Datenbereich ist nicht freigegeben.');
    if (finalKind === 'new-file' && area !== 'agent-output') {
        throw new LocalTaskInputError('Neue Dateien dürfen nur unter agent-output/ erstellt werden.');
    }
    if (finalKind !== 'directory' && segments.length < 2) {
        throw new LocalTaskInputError('Für Dateioperationen ist ein Dateiname erforderlich.');
    }

    let current = root;
    const pathSegments = ['data', ...segments];
    for (let index = 0; index < pathSegments.length; index += 1) {
        current = path.join(current, pathSegments[index]);
        const isFinal = index === pathSegments.length - 1;
        const shouldCreate = !isFinal || finalKind === 'directory';
        let info: Awaited<ReturnType<typeof fs.lstat>> | null = null;
        try {
            info = await fs.lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            if (!shouldCreate) {
                if (finalKind === 'new-file') {
                    await ensureSafeParents(root, ['data', ...segments.slice(0, -1)]);
                    return current;
                }
                throw error;
            }
            await fs.mkdir(current);
            info = await fs.lstat(current);
        }
        if (info.isSymbolicLink()) throw new LocalTaskInputError('Symbolische Links sind in lokalen Task-Pfaden nicht erlaubt.');
        if (shouldCreate && !info.isDirectory()) throw new LocalTaskInputError('Ein Pfadsegment ist kein Verzeichnis.');
        if (isFinal && finalKind === 'directory' && !info.isDirectory()) {
            throw new LocalTaskInputError('Der angeforderte Pfad ist kein Verzeichnis.');
        }
        if (isFinal && finalKind === 'file' && !info.isFile()) {
            throw new LocalTaskInputError('Der angeforderte Pfad ist keine reguläre Datei.');
        }
        if (isFinal && finalKind === 'new-file' && info) {
            throw new LocalTaskInputError('Die Zieldatei existiert bereits; Überschreiben ist nicht erlaubt.');
        }
    }

    const resolved = await fs.realpath(current);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new LocalTaskInputError('Der aufgelöste Pfad liegt außerhalb des Arbeitsbereichs.');
    }
    return current;
}

async function ensureSafeParents(root: string, segments: string[]): Promise<void> {
    let current = root;
    for (const segment of segments) {
        current = path.join(current, segment);
        try {
            const info = await fs.lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) {
                throw new LocalTaskInputError('Ein übergeordnetes Verzeichnis ist ungültig oder ein symbolischer Link.');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await fs.mkdir(current);
        }
    }
}
