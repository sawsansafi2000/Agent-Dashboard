import { User } from '../../models/user.model';
import { db } from '../index';

const seedAdmin = async () => {
    const adminUser = {
        email: 'kontakt@naturvitale.tech',
        password: 'Xazzmiy00!', // Ensure to hash this password in production
        role: 'admin',
    };

    try {
        await db.transaction(async (transaction) => {
            const existingUser = await User.findOne({ where: { email: adminUser.email } }, { transaction });

            if (!existingUser) {
                await User.create(adminUser, { transaction });
                console.log('Admin user seeded successfully.');
            } else {
                console.log('Admin user already exists. Skipping seed.');
            }
        });
    } catch (error) {
        console.error('Error seeding admin user:', error);
    }
};

seedAdmin();