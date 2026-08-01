import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

export interface StoredOrder {
    checkoutSessionId: string;
    projectSlug: string | null;
    paymentStatus: string;
    amountTotal: number;
    currency: string;
    customerEmail: string | null;
    updatedAt: string;
}

interface OrderDocument {
    version: 1;
    processedEventIds: string[];
    orders: StoredOrder[];
}

export class OrderStore {
    private readonly file: string;
    private readonly lockDirectory: string;

    constructor(rootDirectory: string) {
        this.file = path.join(rootDirectory, 'data', 'orders.json');
        this.lockDirectory = `${this.file}.lock`;
    }

    async recordCheckoutEvent(input: { eventId: string; order: StoredOrder }): Promise<{ duplicate: boolean; order: StoredOrder }> {
        const release = await this.acquireLock();
        try {
            const document = await this.read();
            if (document.processedEventIds.includes(input.eventId)) return { duplicate: true, order: input.order };
            const existing = document.orders.find(order => order.checkoutSessionId === input.order.checkoutSessionId);
            if (existing) Object.assign(existing, input.order);
            else document.orders.push(input.order);
            document.processedEventIds.push(input.eventId);
            await this.write(document);
            return { duplicate: false, order: input.order };
        } finally {
            await release();
        }
    }

    async releaseCheckoutEvent(eventId: string): Promise<void> {
        const release = await this.acquireLock();
        try {
            const document = await this.read();
            document.processedEventIds = document.processedEventIds.filter(processedEventId => processedEventId !== eventId);
            await this.write(document);
        } finally {
            await release();
        }
    }

    async list(): Promise<StoredOrder[]> {
        return (await this.read()).orders;
    }

    private async read(): Promise<OrderDocument> {
        try {
            const document = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<OrderDocument>;
            return {
                version: 1,
                processedEventIds: Array.isArray(document.processedEventIds) ? document.processedEventIds : [],
                orders: Array.isArray(document.orders) ? document.orders : [],
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, processedEventIds: [], orders: [] };
            throw error;
        }
    }

    private async write(document: OrderDocument): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(document, null, 2), 'utf8');
        await fs.rename(temporaryFile, this.file);
    }

    private async acquireLock(): Promise<() => Promise<void>> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const deadline = Date.now() + 10_000;
        while (true) {
            try {
                await fs.mkdir(this.lockDirectory);
                return () => fs.rm(this.lockDirectory, { recursive: true, force: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
    }
}