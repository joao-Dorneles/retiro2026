require('dotenv').config();
const { Pool } = require('pg');

// Configuração que funciona tanto no seu PC quanto no Render
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Teste de conexão (opcional, mas bom pra debug)
pool.connect()
    .then(() => console.log('✅ Banco de dados conectado com sucesso!'))
    .catch(err => console.error('❌ Erro ao conectar no banco:', err));

module.exports = pool;