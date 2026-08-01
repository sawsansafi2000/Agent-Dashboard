import React from 'react';

const Header: React.FC = () => {
    return (
        <header>
            <h1>Natur Vitale Internal App</h1>
            <nav>
                <ul>
                    <li><a href="/dashboard">Dashboard</a></li>
                    <li><a href="/login">Login</a></li>
                </ul>
            </nav>
        </header>
    );
};

export default Header;