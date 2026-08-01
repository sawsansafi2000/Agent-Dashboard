export interface User {
    id: number;
    username: string;
    password: string;
}

export class UserModel {
    private users: User[] = [];

    public createUser(username: string, password: string): User {
        const newUser: User = {
            id: this.users.length + 1,
            username,
            password
        };
        this.users.push(newUser);
        return newUser;
    }

    public findUserById(id: number): User | undefined {
        return this.users.find(user => user.id === id);
    }

    public findUserByUsername(username: string): User | undefined {
        return this.users.find(user => user.username === username);
    }

    public getAllUsers(): User[] {
        return this.users;
    }
}