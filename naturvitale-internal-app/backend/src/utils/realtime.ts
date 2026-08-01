import { Server } from 'socket.io';

let io: Server;

export const initializeRealtime = (httpServer: any) => {
    io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    });

    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
        });
    });
};

export const emitUpdate = (event: string, data: any) => {
    if (io) {
        io.emit(event, data);
    }
};