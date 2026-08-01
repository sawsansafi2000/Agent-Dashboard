import { Router } from 'express';
import { login, register } from '../controllers/auth.controller';
import { getAdminData } from '../controllers/admin.controller';

const router = Router();

// Authentication routes
router.post('/login', login);
router.post('/register', register);

// Admin routes
router.get('/admin/data', getAdminData);

export default router;