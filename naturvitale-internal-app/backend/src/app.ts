import express from 'express';
import bodyParser from 'body-parser';
import session from 'express-session';
import { json, urlencoded } from 'body-parser';
import { connectDB } from './db';
import routes from './routes';
import { sessionConfig } from './config';

const app = express();

// Middleware
app.use(json());
app.use(urlencoded({ extended: true }));
app.use(session(sessionConfig));

// Connect to the database
connectDB();

// Set up routes
app.use('/api', routes);

export default app;