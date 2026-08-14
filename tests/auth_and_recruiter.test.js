const request = require('supertest');
const { expect } = require('chai');
const bcrypt = require('bcrypt');
const app = require('../app');
const { pool } = require('../db/config');
const path = require('path');

describe('Auth and Recruiter flows', function() {
  let agent;

  before(async function() {
    // ensure users table exists
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(200) NOT NULL,
      role VARCHAR(50) NOT NULL,
      display_name VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    const passwordHash = await bcrypt.hash('password', 10);
    await pool.query(`INSERT INTO users (username,password,role,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password`, ['recruiter_test', passwordHash, 'recruiter', 'Recruiter Test']);

    // cleanup employees table rows for test id_cards
    await pool.query(`DELETE FROM employees WHERE id_card IN ('110101199001011234','110101199202022345')`);

    agent = request.agent(app);
  });

  after(async function() {
    await pool.query(`DELETE FROM users WHERE username = $1`, ['recruiter_test']);
    await pool.query(`DELETE FROM employees WHERE id_card IN ('110101199001011234','110101199202022345')`);
    // do not close pool here to avoid interfering with other tests, but you can if desired
  });

  it('logs in recruiter and uploads recruiter template', async function() {
    // login
    const loginRes = await agent
      .post('/login')
      .type('form')
      .send({ username: 'recruiter_test', password: 'password' })
      .expect(302);

    // follow redirect to /
    const home = await agent.get('/').expect(200);

    // upload recruiter template
    const uploadPath = path.join(__dirname, '..', 'samples', 'recruiter_template.xlsx');
    const uploadRes = await agent
      .post('/recruiter/import')
      .attach('file', uploadPath)
      .expect(200);

    // verify employees created
    const { rows } = await pool.query(`SELECT id_card, name FROM employees WHERE id_card IN ('110101199001011234','110101199202022345') ORDER BY id`);
    expect(rows.length).to.equal(2);
    expect(rows.map(r => r.id_card)).to.include('110101199001011234');
  });
});
