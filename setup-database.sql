-- United Fund HR System - Database Setup (MySQL)
-- Run this SQL script to create a fresh database

-- Drop existing tables if they exist
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS payroll;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS leaves;
DROP TABLE IF EXISTS crm_leads;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS users;

-- Create tables
CREATE TABLE users (
  id VARCHAR(255) PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(50) NOT NULL,
  employee_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE employees (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(100) NOT NULL,
  position_level VARCHAR(100),
  department VARCHAR(100),
  email VARCHAR(255),
  avatar TEXT,
  status VARCHAR(50) DEFAULT 'active',
  join_date DATE,
  salary DECIMAL(10, 2),
  phone VARCHAR(50),
  manager_id VARCHAR(255),
  permissions TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tasks (
  id VARCHAR(255) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(100),
  notes TEXT,
  assigned_to VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  priority VARCHAR(50),
  due_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE crm_leads (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  source VARCHAR(100),
  status VARCHAR(50) DEFAULT 'new',
  notes TEXT,
  assigned_to VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE leaves (
  id VARCHAR(255) PRIMARY KEY,
  employee_id VARCHAR(255) NOT NULL,
  type VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'Pending',
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE attendance (
  id VARCHAR(255) PRIMARY KEY,
  employee_id VARCHAR(255) NOT NULL,
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payroll (
  id VARCHAR(255) PRIMARY KEY,
  employee_id VARCHAR(255) NOT NULL,
  month INT NOT NULL,
  year INT NOT NULL,
  salary DECIMAL(10, 2) NOT NULL,
  bonus DECIMAL(10, 2) DEFAULT 0.00,
  deductions DECIMAL(10, 2) DEFAULT 0.00,
  total_paid DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE expenses (
  id VARCHAR(255) PRIMARY KEY,
  category VARCHAR(100) NOT NULL,
  description TEXT,
  amount DECIMAL(10, 2) NOT NULL,
  date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  paid_to VARCHAR(255),
  approved_by VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE invoices (
  id VARCHAR(255) PRIMARY KEY,
  client_name VARCHAR(255) NOT NULL,
  client_email VARCHAR(255),
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  status VARCHAR(50) DEFAULT 'pending',
  date DATE NOT NULL,
  due_date DATE,
  notes TEXT,
  type VARCHAR(50) DEFAULT 'sale',
  reason TEXT,
  items TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create default admin user
-- Username: admin
-- Password: admin123 (you should change this after first login)
-- Note: This is a placeholder hash - replace with actual bcrypt hash
INSERT INTO users (id, username, password_hash, role, employee_id) 
VALUES ('admin_001', 'admin', '$2b$10$rKvGxYzZxZxZxZxZxZxZxZeK9mX0qZxZxZxZxZxZxZxZxZxZxZxZxZxZ', 'admin', NULL);
