import { Server } from "socket.io";
import { createServer } from "http";
import app from "../app"; // Import the Express app
import { getActiveAgents } from "../services/agentService"; // Import the service to fetch active agents

const httpServer = createServer(app);
const io = new Server(httpServer);

io.on("connection", (socket) => {
    console.log("A user connected");

    // Emit active agents every 5 minutes
    const interval = setInterval(async () => {
        const activeAgents = await getActiveAgents();
        socket.emit("updateAgents", activeAgents);
    }, 300000); // 300000 ms = 5 minutes

    socket.on("disconnect", () => {
        console.log("A user disconnected");
        clearInterval(interval);
    });
});

export { httpServer, io };