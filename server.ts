import express from 'express';
// import { createServer as createViteServer } from 'vite'; // Moved to dynamic import
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('[Server] Starting initialization...');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log(`[Server] Working directory: ${process.cwd()}`);
console.log(`[Server] __dirname: ${__dirname}`);
console.log(`[Server] NODE_ENV: ${process.env.NODE_ENV}`);

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const PORT = 3000;

// SQLite Database
const dbPath = path.resolve(__dirname, 'united_fund_hr.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

console.log('[Server] Database initialized at', dbPath);

// Simple database helper functions
function dbPrepare(sql: string) {
  return db.prepare(sql);
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    employee_id TEXT
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    position_level TEXT DEFAULT 'Employee',
    department TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    avatar TEXT,
    status TEXT NOT NULL,
    join_date TEXT NOT NULL,
    salary REAL NOT NULL,
    phone TEXT,
    balance_annual_hours REAL DEFAULT 160,
    balance_sick_hours REAL DEFAULT 80,
    manager_id TEXT,
    permissions TEXT DEFAULT '[]' -- JSON array of strings
  );

  CREATE TABLE IF NOT EXISTS leaves (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    type TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    hours REAL DEFAULT 8,
    status TEXT NOT NULL,
    reason TEXT,
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    clock_in TEXT NOT NULL,
    clock_out TEXT,
    date TEXT NOT NULL,
    status TEXT DEFAULT 'Present', -- 'Present', 'Working Remotely', 'Away'
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_email TEXT,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    status TEXT NOT NULL,
    date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    notes TEXT,
    type TEXT DEFAULT 'sale', -- 'sale' or 'purchase'
    reason TEXT
  );

  -- Operations Tables
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT, -- e.g. 'Consultation', 'Development', 'Audit'
    notes TEXT,
    assigned_to TEXT,
    status TEXT NOT NULL, -- 'pending', 'in-progress', 'completed'
    priority TEXT NOT NULL, -- 'low', 'medium', 'high'
    due_date TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(assigned_to) REFERENCES employees(id)
  );

  -- Marketing/CRM Tables
  CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    source TEXT,
    status TEXT NOT NULL, -- 'new', 'contacted', 'qualified', 'interested', 'client', 'lost'
    notes TEXT,
    assigned_to TEXT,
    is_interested INTEGER DEFAULT 0,
    is_converted INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY(assigned_to) REFERENCES employees(id)
  );

  -- Finance Tables
  CREATE TABLE IF NOT EXISTS payroll (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    month TEXT NOT NULL,
    year INTEGER NOT NULL,
    base_salary REAL NOT NULL,
    bonus REAL DEFAULT 0,
    deductions REAL DEFAULT 0,
    total_paid REAL NOT NULL,
    status TEXT NOT NULL, -- 'Pending', 'Approved', 'Paid'
    processed_at TEXT,
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS company_policies (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_data TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT NOT NULL
  );
`);

// Migrations
try {
  db.prepare("ALTER TABLE invoices ADD COLUMN type TEXT DEFAULT 'sale'").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE invoices ADD COLUMN items TEXT").run();
} catch (e) {}

// Seed Admin if not exists
const adminUsername = 'gasrawi';
const adminPassword = 'gasrawi1234';
const adminUser = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUsername);

if (!adminUser) {
  const hash = bcrypt.hashSync(adminPassword, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'ADMIN_UF',
    adminUsername,
    hash,
    'admin'
  );
} else {
  // Update password and role just in case using UPDATE instead of INSERT
  const hash = bcrypt.hashSync(adminPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE username = ?').run(
    hash,
    'admin',
    adminUsername
  );
}

// Clear all employees from database (except admin user)
// This resets the system to empty state
try {
  const empCount = (db.prepare('SELECT COUNT(*) as count FROM employees').get() as any).count;
  if (empCount > 0) {
    console.log(`[Server] Clearing ${empCount} employees from database...`);
    // Delete employee-linked users first (to avoid foreign key issues)
    db.prepare("DELETE FROM users WHERE employee_id IS NOT NULL").run();
    db.prepare("DELETE FROM employees").run();
    console.log('[Server] Employees cleared successfully');
  }
} catch (e) {
  console.log('[Server] Failed to clear employees:', e);
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
};

// Root logger for health checks
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/api/health') {
    console.log(`[Server] Health check request: ${req.method} ${req.path}`);
  }
  next();
});

// API Routes
app.get('/api/admin/download-db', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const dbFile = dbPath;
  if (dbFile === ':memory:') {
    return res.status(400).json({ error: 'Database is in-memory and cannot be downloaded directly' });
  }

  res.download(dbFile, 'united_fund_hr_backup.db');
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    db: dbPath
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  // Try to find user by username first
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  
  // If not found by username, try to find by email or phone from employees table
  if (!user) {
    const employee = db.prepare('SELECT * FROM employees WHERE email = ? OR phone = ?').get(username, username) as any;
    if (employee) {
      user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employee.id) as any;
    }
  }

  if (user && bcrypt.compareSync(password, user.password_hash)) {
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, employee_id: user.employee_id }, JWT_SECRET, { expiresIn: '8h' });
    
    let employee = null;
    if (user.employee_id) {
      employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(user.employee_id);
    }

    res.json({ token, user: { ...user, password_hash: undefined }, employee });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/forgot-password', (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    // Try to find user by username first
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
    
    // If not found by username, try to find by email or phone from employees table
    if (!user) {
      const employee = db.prepare('SELECT * FROM employees WHERE email = ? OR phone = ?').get(username, username) as any;
      if (employee) {
        user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employee.id) as any;
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get employee details
    let employee = null;
    if (user.employee_id) {
      employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(user.employee_id) as any;
    }

    const employeeName = employee?.name || user.username;
    const employeeEmail = employee?.email || 'N/A';
    const employeePhone = employee?.phone || 'N/A';

    // Log the request for admin to see
    console.log(`[Forgot Password] User: ${user.username}, Name: ${employeeName}, Email: ${employeeEmail}, Phone: ${employeePhone}`);
    
    return res.json({ 
      message: 'Password reset request has been sent to admin',
      userName: employeeName,
      userEmail: employeeEmail
    });
  } catch (error) {
    console.error('[Forgot Password] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', authenticateToken, (req: any, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) as any;
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  let employee = null;
  if (user.employee_id) {
    employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(user.employee_id);
  }
  
  res.json({ user: { ...user, password_hash: undefined }, employee });
});

app.get('/api/employees', authenticateToken, (req: any, res) => {
  if (req.user.role === 'admin') {
    const employees = db.prepare('SELECT * FROM employees').all().map((e: any) => ({
      ...e,
      permissions: JSON.parse(e.permissions || '[]')
    }));
    res.json(employees);
  } else {
    // Check if the user is a manager/team lead
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.user.employee_id) as any;
    if (!employee) return res.json([]);

    if (['Team Lead', 'Supervisor', 'Manager', 'Director', 'Executive'].includes(employee.position_level)) {
      // Find subordinates
      const subordinates = db.prepare('SELECT * FROM employees WHERE manager_id = ? OR id = ?').all(employee.id, employee.id);
      res.json(subordinates.map((e: any) => ({
        ...e,
        permissions: JSON.parse(e.permissions || '[]')
      })));
    } else {
      res.json([{ ...employee, permissions: JSON.parse(employee.permissions || '[]') }]);
    }
  }
});

app.post('/api/employees', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const { id, name, role, position_level, department, email, avatar, status, joinDate, salary, phone, manager_id, permissions, username, password } = req.body;
  
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO employees (id, name, role, position_level, department, email, avatar, status, join_date, salary, phone, manager_id, permissions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, role, position_level, department, email, avatar, status, joinDate, salary, phone, manager_id, JSON.stringify(permissions || []));

    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, employee_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id + '_USER', username, hash, 'employee', id);
  });

  try {
    transaction();
    res.status(201).json({ message: 'Employee and user created successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/leaves', authenticateToken, (req: any, res) => {
  if (req.user.role === 'admin') {
    const leaves = db.prepare(`
      SELECT l.*, e.name as employeeName 
      FROM leaves l 
      JOIN employees e ON l.employee_id = e.id
    `).all();
    res.json(leaves);
  } else {
    const leaves = db.prepare(`
      SELECT l.*, e.name as employeeName 
      FROM leaves l 
      JOIN employees e ON l.employee_id = e.id 
      WHERE l.employee_id = ?
    `).all(req.user.employee_id);
    res.json(leaves);
  }
});

app.post('/api/leaves', authenticateToken, (req: any, res) => {
  const { id, type, startDate, endDate, reason } = req.body;
  const employeeId = req.user.role === 'admin' ? req.body.employeeId : req.user.employee_id;

  if (!employeeId) return res.status(400).json({ error: 'Employee ID required' });

  db.prepare(`
    INSERT INTO leaves (id, employee_id, type, start_date, end_date, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, employeeId, type, startDate, endDate, 'Pending', reason);

  res.status(201).json({ message: 'Leave request created' });
});

app.patch('/api/leaves/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { status } = req.body;
  const { id } = req.params;

  try {
    db.prepare('UPDATE leaves SET status = ? WHERE id = ?').run(status, id);
    res.json({ message: `Leave ${status.toLowerCase()} successfully` });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/attendance/status', authenticateToken, (req: any, res) => {
  const employeeId = req.user.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Not an employee' });

  const today = new Date().toISOString().split('T')[0];
  const lastRecord = db.prepare(`
    SELECT * FROM attendance 
    WHERE employee_id = ? AND date = ? 
    ORDER BY clock_in DESC LIMIT 1
  `).get(employeeId) as any;

  res.json({ lastRecord });
});

app.post('/api/attendance/clock-in', authenticateToken, (req: any, res) => {
  const employeeId = req.user.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Not an employee' });

  const now = new Date().toISOString();
  const today = now.split('T')[0];

  const active = db.prepare(`
    SELECT * FROM attendance 
    WHERE employee_id = ? AND date = ? AND clock_out IS NULL
  `).get(employeeId);

  if (active) return res.status(400).json({ error: 'Already clocked in' });

  db.prepare(`
    INSERT INTO attendance (employee_id, clock_in, date)
    VALUES (?, ?, ?)
  `).run(employeeId, now, today);

  res.json({ message: 'Clocked in successfully', time: now });
});

app.post('/api/attendance/clock-out', authenticateToken, (req: any, res) => {
  const employeeId = req.user.employee_id;
  if (!employeeId) return res.status(400).json({ error: 'Not an employee' });

  const now = new Date().toISOString();
  
  const active = db.prepare(`
    SELECT * FROM attendance 
    WHERE employee_id = ? AND clock_out IS NULL
    ORDER BY clock_in DESC LIMIT 1
  `).get(employeeId) as any;

  if (!active) return res.status(400).json({ error: 'Not clocked in' });

  db.prepare(`
    UPDATE attendance SET clock_out = ? WHERE id = ?
  `).run(now, active.id);

  res.json({ message: 'Clocked out successfully', time: now });
});

app.get('/api/attendance', authenticateToken, (req: any, res) => {
  // Redirect or alias to history
  res.redirect('/api/attendance/history');
});

app.get('/api/attendance/history', authenticateToken, (req: any, res) => {
  if (req.user.role === 'admin') {
    const history = db.prepare(`
      SELECT a.*, e.name as employeeName, e.name as employee_name
      FROM attendance a 
      JOIN employees e ON a.employee_id = e.id
      ORDER BY a.clock_in DESC
    `).all();
    res.json(history);
  } else {
    const history = db.prepare(`
      SELECT a.*, e.name as employeeName, e.name as employee_name
      FROM attendance a 
      JOIN employees e ON a.employee_id = e.id
      WHERE a.employee_id = ?
      ORDER BY a.clock_in DESC
    `).all(req.user.employee_id);
    res.json(history);
  }
});

// AI Data Endpoints for tools
app.get('/api/ai/tools/attendance-stats', authenticateToken, (req: any, res) => {
  const today = new Date().toISOString().split('T')[0];
  const clockedIn = db.prepare('SELECT COUNT(DISTINCT employee_id) as count FROM attendance WHERE date = ?').get(today) as any;
  const onLeave = db.prepare('SELECT COUNT(*) as count FROM employees WHERE status = ?').get('On Leave') as any;
  const total = db.prepare('SELECT COUNT(*) as count FROM employees').get() as any;
  res.json({
    clocked_in_today: clockedIn.count,
    on_leave: onLeave.count,
    total_employees: total.count,
    absent: total.count - clockedIn.count - onLeave.count
  });
});

app.get('/api/ai/tools/salaries', authenticateToken, (req: any, res) => {
  const employees = db.prepare('SELECT name, department, role, salary FROM employees').all();
  res.json({ employees });
});

app.get('/api/ai/tools/dept-stats', authenticateToken, (req: any, res) => {
  const stats = db.prepare('SELECT department, COUNT(*) as count FROM employees GROUP BY department').all();
  res.json({ departments: stats });
});

app.delete('/api/employees/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const { id } = req.params;
  
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM users WHERE employee_id = ?').run(id);
    db.prepare('DELETE FROM attendance WHERE employee_id = ?').run(id);
    db.prepare('DELETE FROM leaves WHERE employee_id = ?').run(id);
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  });

  try {
    transaction();
    res.json({ message: 'Employee deleted successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/employees', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM users WHERE employee_id IS NOT NULL").run();
    db.prepare('DELETE FROM attendance').run();
    db.prepare('DELETE FROM leaves').run();
    db.prepare('DELETE FROM employees').run();
  });

  try {
    transaction();
    res.json({ message: 'All employees deleted successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/payroll/disburse', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  const today = new Date().toISOString().split('T')[0];
  try {
    db.prepare('UPDATE employees SET salary = salary').run(); // Just a dummy update to ensure rows exist
    // In a real app we'd insert into a 'payments' table. 
    // Here let's just simulate success for the admin.
    res.json({ message: 'Payroll disbursed successfully for all active employees', date: today });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/candidates/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id } = req.params;
  const { stage } = req.body;
  
  res.json({ message: 'Candidate status updated', id, stage });
});

app.put('/api/employees/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id } = req.params;
  const { name, role, position_level, department, email, avatar, status, salary, phone, manager_id, permissions, password } = req.body;

  try {
    const existingEmployee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as any;
    if (!existingEmployee) return res.status(404).json({ error: 'Employee not found' });

    db.prepare(`
      UPDATE employees 
      SET name = ?, role = ?, position_level = ?, department = ?, email = ?, avatar = ?, status = ?, salary = ?, phone = ?, manager_id = ?, permissions = ?
      WHERE id = ?
    `).run(
      name ?? existingEmployee.name,
      role ?? existingEmployee.role,
      position_level ?? existingEmployee.position_level,
      department ?? existingEmployee.department,
      email ?? existingEmployee.email,
      avatar ?? existingEmployee.avatar,
      status ?? existingEmployee.status,
      salary ?? existingEmployee.salary,
      phone ?? existingEmployee.phone,
      manager_id ?? existingEmployee.manager_id,
      permissions ? JSON.stringify(permissions) : existingEmployee.permissions,
      id
    );

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE employee_id = ?').run(hash, id);
    }

    res.json({ message: 'Employee updated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Tasks API
app.get('/api/tasks', authenticateToken, (req, res) => {
  const tasks = db.prepare('SELECT t.*, e.name as assigned_name FROM tasks t LEFT JOIN employees e ON t.assigned_to = e.id ORDER BY t.created_at DESC').all();
  res.json(tasks);
});

app.post('/api/tasks', authenticateToken, (req: any, res) => {
  const { title, description, type, notes, assigned_to, priority, due_date } = req.body;
  const id = 'TASK_' + Math.random().toString(36).substr(2, 9);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO tasks (id, title, description, type, notes, assigned_to, status, priority, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title, description, type, notes, assigned_to, 'pending', priority, due_date, now);
  res.json({ message: 'Task created' });
});

app.put('/api/tasks/:id', authenticateToken, (req: any, res) => {
  const { id } = req.params;
  const { status } = req.body;
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  res.json({ message: 'Task updated' });
});

// CRM Leads API
app.get('/api/crm/leads', authenticateToken, (req: any, res) => {
  const leads = db.prepare('SELECT * FROM crm_leads ORDER BY created_at DESC').all();
  res.json(leads.map((l: any) => ({
    ...l,
    isInterested: !!l.is_interested,
    isConverted: !!l.is_converted
  })));
});

app.post('/api/crm/leads', authenticateToken, (req, res) => {
  const { name, email, phone, source, notes, assigned_to } = req.body;
  const id = 'LEAD_' + Math.random().toString(36).substr(2, 9);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO crm_leads (id, name, email, phone, source, status, notes, assigned_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, email, phone, source, 'new', notes, assigned_to, now);
  res.json({ message: 'Lead added' });
});

app.patch('/api/crm/leads/:id', authenticateToken, (req: any, res) => {
  const { id } = req.params;
  const { status, isInterested, isConverted, notes } = req.body;
  
  db.prepare(`
    UPDATE crm_leads 
    SET status = COALESCE(?, status), 
        is_interested = COALESCE(?, is_interested), 
        is_converted = COALESCE(?, is_converted),
        notes = COALESCE(?, notes)
    WHERE id = ?
  `).run(status, isInterested ? 1 : 0, isConverted ? 1 : 0, notes, id);
  
  res.json({ message: 'Lead updated' });
});

// Finance / Payroll API
app.get('/api/payroll', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const payroll = db.prepare(`
    SELECT p.*, e.name as employeeName 
    FROM payroll p 
    JOIN employees e ON p.employee_id = e.id
    ORDER BY p.year DESC, p.month DESC
  `).all();
  res.json(payroll);
});

app.post('/api/payroll/approve', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { employeeId, month, year, bonus, deductions } = req.body;
  
  const employee = db.prepare('SELECT salary FROM employees WHERE id = ?').get(employeeId) as any;
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const totalPaid = employee.salary + (bonus || 0) - (deductions || 0);
  const id = `PAY_${employeeId}_${year}_${month}`;

  db.prepare(`
    INSERT OR REPLACE INTO payroll (id, employee_id, month, year, base_salary, bonus, deductions, total_paid, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, employeeId, month, year, employee.salary, bonus || 0, deductions || 0, totalPaid, 'Approved');

  res.json({ message: 'Payroll record approved' });
});

// Expenses API
app.get('/api/expenses', authenticateToken, (req, res) => {
  const expenses = db.prepare('SELECT * FROM expenses ORDER BY date DESC').all();
  res.json(expenses);
});

app.post('/api/expenses', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { category, description, amount, date, paid_to } = req.body;
  const id = 'EXP_' + Math.random().toString(36).substr(2, 9);
  db.prepare('INSERT INTO expenses (id, category, description, amount, date, status, paid_to, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, category, description, amount, date, 'paid', paid_to, req.user.username);
  res.json({ message: 'Expense recorded' });
});

// Billing API Routes
app.get('/api/invoices', authenticateToken, (req: any, res) => {
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY date DESC').all();
  const invoicesWithItems = invoices.map((inv: any) => ({
    ...inv,
    items: inv.items ? JSON.parse(inv.items) : []
  }));
  res.json(invoicesWithItems);
});

app.post('/api/invoices', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id, client_name, client_email, amount, currency, status, date, due_date, notes, type, reason, items } = req.body;

  try {
    const itemsJson = items ? JSON.stringify(items) : null;
    db.prepare(`
      INSERT INTO invoices (id, client_name, client_email, amount, currency, status, date, due_date, notes, type, reason, items)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, client_name, client_email, amount, currency || 'USD', status, date, due_date, notes, type || 'sale', reason, itemsJson);
    res.status(201).json({ message: 'Invoice created successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Currency API
app.get('/api/currency/rates', (req, res) => {
  const rates = {
    'USD': 1,
    'JOD': 0.71,
    'EGP': 30.9
  };
  res.json(rates);
});

app.put('/api/invoices/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id } = req.params;
  const { client_name, client_email, amount, currency, status, date, due_date, notes, type, reason, items } = req.body;

  try {
    const existingInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
    if (!existingInvoice) return res.status(404).json({ error: 'Invoice not found' });

    const itemsJson = items ? JSON.stringify(items) : null;

    db.prepare(`
      UPDATE invoices
      SET client_name = COALESCE(?, client_name),
          client_email = COALESCE(?, client_email),
          amount = COALESCE(?, amount),
          currency = COALESCE(?, currency),
          status = COALESCE(?, status),
          date = COALESCE(?, date),
          due_date = COALESCE(?, due_date),
          notes = COALESCE(?, notes),
          type = COALESCE(?, type),
          reason = COALESCE(?, reason),
          items = COALESCE(?, items)
      WHERE id = ?
    `).run(client_name, client_email, amount, currency, status, date, due_date, notes, type, reason, itemsJson, id);

    res.json({ message: 'Invoice updated successfully' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.patch('/api/invoices/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { status } = req.body;
  const { id } = req.params;

  try {
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, id);
    res.json({ message: 'Invoice status updated' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/invoices/:id', authenticateToken, (req: any, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { id } = req.params;

  try {
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    res.json({ message: 'Invoice deleted' });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const indexPath = path.join(distPath, 'index.html');
    
    console.log(`[Server] Serving production assets from ${distPath}`);
    
    if (!fs.existsSync(distPath)) {
      console.error(`[Server] FATAL: Dist directory not found at ${distPath}`);
    } else if (!fs.existsSync(indexPath)) {
      console.error(`[Server] FATAL: index.html not found at ${indexPath}`);
    }

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Not Found - Build missing');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Success! Running on http://0.0.0.0:${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
  });
}

// Add email sending endpoint before app.listen
app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, body } = req.body;
    
    console.log('[Server] Email request received:', { to, subject, body });
    
    // TODO: Integrate with actual email service like Nodemailer
    // For now, just log the email and return success
    console.log('[Server] Email would be sent to:', to);
    console.log('[Server] Subject:', subject);
    console.log('[Server] Body:', body);
    
    res.json({ success: true, message: 'Email logged successfully' });
  } catch (error) {
    console.error('[Server] Email error:', error);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// Upload company policy endpoint
app.post('/api/policies/upload', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const { file_data, title, file_name, file_type } = req.body;

    if (!file_data || !title || !file_name || !file_type) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const policyId = `policy_${Date.now()}`;
    const uploadedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO company_policies (id, title, file_data, file_name, file_type, uploaded_at, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(policyId, title, file_data, file_name, file_type, uploadedAt, decoded.username);

    console.log('[Server] Policy uploaded:', { policyId, title, uploadedBy: decoded.username });

    res.json({ success: true, message: 'Policy uploaded successfully', policyId });
  } catch (error: any) {
    console.error('[Server] Policy upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload policy' });
  }
});

// Get company policies endpoint
app.get('/api/policies', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const policies = db.prepare(`
      SELECT id, title, file_name, file_type, uploaded_at, uploaded_by
      FROM company_policies
      ORDER BY uploaded_at DESC
    `).all();

    res.json({ success: true, policies });
  } catch (error: any) {
    console.error('[Server] Get policies error:', error);
    res.status(500).json({ success: false, message: 'Failed to get policies' });
  }
});

// Get single policy file endpoint
app.get('/api/policies/:id', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const policy = db.prepare(`
      SELECT id, title, file_data, file_name, file_type, uploaded_at, uploaded_by
      FROM company_policies
      WHERE id = ?
    `).get(req.params.id) as any;

    if (!policy) {
      return res.status(404).json({ success: false, message: 'Policy not found' });
    }

    res.json({ success: true, policy });
  } catch (error: any) {
    console.error('[Server] Get policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to get policy' });
  }
});

startServer().catch(err => {
  console.error('[Server] FATAL: Failed to start server:', err);
  process.exit(1);
});
