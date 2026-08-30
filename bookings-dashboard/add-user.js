const bcrypt = require('bcryptjs');
const fs = require('fs');
const readline = require('readline');

const USERS_FILE = './users.json';

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Username: ', (username) => {
  rl.question('Password: ', (password) => {
    rl.question('Role (admin/staff): ', (role) => {
      const users = loadUsers().filter((u) => u.username !== username);
      const passwordHash = bcrypt.hashSync(password, 10);
      users.push({ username, passwordHash, role: role || 'staff' });
      saveUsers(users);
      console.log(`Saved user "${username}" with role "${role || 'staff'}".`);
      rl.close();
    });
  });
});
