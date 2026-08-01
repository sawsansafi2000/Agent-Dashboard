import { Request, Response } from 'express';
import { getAdminData, updateAdminData } from '../services/admin.service';

export const getAdminInfo = async (req: Request, res: Response) => {
    try {
        const adminData = await getAdminData();
        res.status(200).json(adminData);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving admin data', error });
    }
};

export const updateAdminInfo = async (req: Request, res: Response) => {
    try {
        const updatedData = await updateAdminData(req.body);
        res.status(200).json(updatedData);
    } catch (error) {
        res.status(500).json({ message: 'Error updating admin data', error });
    }
};