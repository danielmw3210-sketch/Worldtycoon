/**
 * Game accounts.
 *
 * Accounts are a game-layer identity mapped 1:1 to a Numista username. They do
 * not hold wallet files: the custodial issuer wallet signs all asset operations
 * for these usernames (see chainAdapter / chainLedger).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(__dirname, 'users.json');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function sessionSecret() {
  if (process.env.NUMISTA_SESSION_SECRET) return process.env.NUMISTA_SESSION_SECRET;
  // Stable across restarts for a single machine; override in production.
  return 'townforge-numista-local-session-secret';
}

class UserManager {
  constructor() {
    this.users = new Map();
    this._load();

    if (this.users.size === 0) {
      this._seedDefaults();
      this.save();
    }
  }

  _load() {
    try {
      if (!fs.existsSync(USERS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      (raw.users || []).forEach(user => {
        if (!user?.username) return;
        this.users.set(user.username.toLowerCase(), {
          username: user.username.toLowerCase(),
          password: user.password || 'password123',
          role: user.role === 'admin' ? 'admin' : 'user',
          createdAt: user.createdAt || new Date().toISOString(),
          wallet: user.wallet || this._emptyWallet(),
          receiveAddress: user.receiveAddress || null
        });
      });
    } catch (err) {
      console.warn('[users] Could not load accounts:', err.message);
    }
  }

  _emptyWallet() {
    return {
      balance: 0,
      unlockedBalance: 0,
      pendingBalance: 0,
      lockedBalance: 0,
      transfers: []
    };
  }

  _seedDefaults() {
    this.users.set('danie', {
      username: 'danie',
      password: 'password123',
      role: 'admin',
      createdAt: '2026-11-18T12:00:00Z',
      wallet: this._emptyWallet()
    });
    this.users.set('mercantile', {
      username: 'mercantile',
      password: 'password123',
      role: 'user',
      createdAt: '2026-11-18T13:00:00Z',
      wallet: this._emptyWallet()
    });
    // Public treasury that receives deed payments. Not a login account.
    this.users.set('crown_treasury', {
      username: 'crown_treasury',
      password: crypto.randomBytes(18).toString('hex'),
      role: 'institution',
      createdAt: new Date().toISOString(),
      wallet: this._emptyWallet()
    });
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
      fs.writeFileSync(USERS_FILE, JSON.stringify({
        savedAt: new Date().toISOString(),
        users: [...this.users.values()]
      }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[users] Could not save accounts:', err.message);
    }
  }

  register({ username, password }) {
    const cleanUser = String(username || '').trim().toLowerCase();

    if (!USERNAME_RE.test(cleanUser)) {
      throw new Error('Username must be 3–32 characters using letters, digits, dot, dash or underscore');
    }
    if (this.users.has(cleanUser)) {
      throw new Error(`Username '@${cleanUser}' is already registered`);
    }

    const record = {
      username: cleanUser,
      password: password || 'password123',
      role: CONFIG.ADMIN_USERS.includes(cleanUser) ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
      wallet: this._emptyWallet(),
      receiveAddress: null
    };

    this.users.set(cleanUser, record);
    this.save();

    return {
      username: record.username,
      role: record.role,
      token: this.issueToken(record.username)
    };
  }

  login({ username, password }) {
    const cleanUser = String(username || '').trim().toLowerCase();
    const user = this.users.get(cleanUser);
    if (!user) throw new Error('User not found. Please create an account.');
    if (user.role === 'institution') throw new Error('This account is not a login account');
    if (user.password !== password) throw new Error('Invalid password');

    return {
      username: user.username,
      role: user.role || 'user',
      token: this.issueToken(user.username)
    };
  }

  issueToken(username) {
    const payload = Buffer.from(JSON.stringify({
      u: String(username).toLowerCase(),
      t: Date.now()
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    try {
      const [payload, sig] = String(token || '').split('.');
      if (!payload || !sig) return null;
      const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return this.getUser(data.u);
    } catch {
      return null;
    }
  }

  isAdmin(username) {
    const user = this.getUser(username);
    if (user?.role === 'admin') return true;
    return CONFIG.ADMIN_USERS.includes(String(username || '').trim().toLowerCase());
  }

  getRole(username) {
    const user = this.getUser(username);
    return user?.role || (CONFIG.ADMIN_USERS.includes(String(username || '').trim().toLowerCase()) ? 'admin' : 'user');
  }

  getUser(username) {
    if (!username) return null;
    return this.users.get(String(username).trim().toLowerCase()) || null;
  }

  setReceiveAddress(username, receiveAddress) {
    const user = this.getUser(username);
    if (!user) throw new Error('User not found');
    if (!user.receiveAddress) {
      user.receiveAddress = receiveAddress;
      this.save();
    }
    return user.receiveAddress;
  }

  allUsernames() {
    return [...this.users.keys()];
  }
}

export const userManager = new UserManager();
