'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');

const usersFile = path.join(__dirname, '..', 'data', 'users.json');

function askHidden(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') return reject(new Error('Esegui questo comando da un terminale interattivo.'));
    process.stdout.write(label);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    let answer = '';
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          input.removeListener('data', onData);
          input.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('Operazione annullata.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          input.removeListener('data', onData);
          input.setRawMode(false);
          process.stdout.write('\n');
          resolve(answer);
          return;
        }
        if (character === '\u007f' || character === '\b') answer = answer.slice(0, -1);
        else if (character >= ' ') answer += character;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  if (!fs.existsSync(usersFile)) throw new Error('Non esistono account. Apri il pannello e crea l’account iniziale.');
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  if (!users.length) throw new Error('Non esistono account. Apri il pannello e crea l’account iniziale.');

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = (await prompt.question(`Account (${users.map(user => `${user.username}${user.role === 'admin' ? ' [admin]' : ''}`).join(', ')}): `)).trim();
  prompt.close();
  const user = users.find(account => account.username.toLowerCase() === username.toLowerCase());
  if (!user) throw new Error('Account non trovato; nessun dato è stato modificato.');

  const password = await askHidden('Nuova password (12-128 caratteri, non visibile): ');
  if (password.length < 12 || password.length > 128) throw new Error('La password deve contenere da 12 a 128 caratteri.');
  const confirmation = await askHidden('Ripeti la nuova password: ');
  if (password !== confirmation) throw new Error('Le password non corrispondono; nessun dato è stato modificato.');

  user.passwordHash = await bcrypt.hash(password, 12);
  const tempFile = `${usersFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(users, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, usersFile);
  process.stdout.write(`Password reimpostata per ${user.username}. Torna alla pagina di login.\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
