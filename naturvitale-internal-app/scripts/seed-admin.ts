import { Database } from '../backend/src/db'; // Adjust the import path as necessary
import { User } from '../backend/src/models/user.model'; // Adjust the import path as necessary

async function seedAdmin() {
    const adminEmail = 'kontakt@naturvitale.tech';
    const adminPassword = 'Xazzmiy00!'; // Use a secure method to handle passwords in production

    const db = new Database();
    await db.connect();

    const existingAdmin = await User.findOne({ email: adminEmail });

    if (!existingAdmin) {
        const adminUser = new User({
            email: adminEmail,
            password: adminPassword, // Ensure to hash the password before saving
            role: 'admin',
        });

        await adminUser.save();
        console.log('Admin user created successfully.');
    } else {
        console.log('Admin user already exists.');
    }

    await db.disconnect();
}

seedAdmin().catch((error) => {
    console.error('Error seeding admin user:', error);
});