import { Sequelize } from 'sequelize';
import path from 'path';

const databasePath = path.resolve(__dirname, '../../database.sqlite');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
});

const connectDatabase = async () => {
    try {
        await sequelize.authenticate();
        console.log('Connection to the SQLite database has been established successfully.');
    } catch (error) {
        console.error('Unable to connect to the SQLite database:', error);
    }
};

connectDatabase();

export default sequelize;