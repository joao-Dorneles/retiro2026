require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const crypto = require('crypto');
const multer = require('multer');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const pool = require('./db'); // O arquivo de conexão que criamos antes

const app = express();

// --- CONFIGURAÇÃO DE PREÇO E LOTE ---
const DATA_FIM_LOTE_1 = new Date('2025-01-20T23:59:59');
const PRECO_LOTE_1 = 100.00;
const PRECO_LOTE_2 = 150.00;

function getPrecoAtual() {
    const hoje = new Date();
    return hoje <= DATA_FIM_LOTE_1 ? PRECO_LOTE_1 : PRECO_LOTE_2;
}

// --- UPLOAD (Atenção: Arquivos somem ao reiniciar no Render Grátis) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- CONFIGURAÇÕES GERAIS ---
const tokenMP = process.env.MP_ACCESS_TOKEN;
const client = new MercadoPagoConfig({ accessToken: tokenMP });
const SENHA_ADMIN = "admin123"; // Sugestão: Coloque isso no .env também

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));

app.use(session({
    secret: 'segredo-retiro-jovem', resave: false, saveUninitialized: true
}));

function verificarAuth(req, res, next) {
    if (req.session.usuarioLogado) next(); else res.redirect('/login');
}

// --- CRIAÇÃO DAS TABELAS (PostgreSQL) ---
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inscricoes (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                cpf TEXT,
                sexo TEXT,
                congregacao TEXT,
                telefone TEXT,
                status TEXT DEFAULT 'Pendente',
                mp_id TEXT,
                qr_code TEXT,
                qr_code_base64 TEXT,
                valor_pago REAL,
                data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS galeria (
                id SERIAL PRIMARY KEY,
                tipo TEXT, url TEXT, titulo TEXT
            )
        `);
        console.log("✅ Tabelas verificadas/criadas.");
    } catch (err) {
        console.error("❌ Erro ao criar tabelas:", err);
    }
})();

// --- ROTAS ---

// Home
app.get('/', async (req, res) => {
    const preco = getPrecoAtual();
    try {
        const resultado = await pool.query("SELECT * FROM galeria ORDER BY id DESC");
        res.render('index', { galeria: resultado.rows || [], preco: preco, dataLimite: DATA_FIM_LOTE_1 });
    } catch (err) {
        console.error(err);
        res.render('index', { galeria: [], preco: preco, dataLimite: DATA_FIM_LOTE_1 });
    }
});

app.get('/login', (req, res) => res.render('login', { erro: false }));
app.post('/login', (req, res) => {
    if (req.body.senha === SENHA_ADMIN) {
        req.session.usuarioLogado = true;
        res.redirect('/admin');
    } else {
        res.render('login', { erro: true });
    }
});
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// INSCRIÇÃO (Lógica adaptada para Postgres)
app.post('/inscrever', async (req, res) => {
    const { nome, cpf, sexo, congregacao, telefone } = req.body;
    const valorRetiro = getPrecoAtual();
    const emailPagador = 'participante@retiro.com'; 

    try {
        // 1. Inserir no Banco e retornar o ID (Postgres precisa do RETURNING id)
        const insertQuery = `
            INSERT INTO inscricoes (nome, cpf, sexo, congregacao, telefone, valor_pago) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
        `;
        const resultDb = await pool.query(insertQuery, [nome, cpf, sexo, congregacao, telefone, valorRetiro]);
        const idInscrito = resultDb.rows[0].id;

        // Se não tiver token configurado, só redireciona
        if (!tokenMP || tokenMP.includes('SEU-TOKEN')) {
            return res.redirect(`/status/${idInscrito}`);
        }

        // 2. Criar Pagamento no Mercado Pago
        const payment = new Payment(client);
        const body = {
            transaction_amount: valorRetiro,
            description: `Inscrição Retiro (${sexo}) - ID ${idInscrito}`,
            payment_method_id: 'pix',
            payer: { 
                email: emailPagador, 
                first_name: nome.split(' ')[0], 
                identification: { type: 'CPF', number: cpf.replace(/\D/g,'') } 
            },
            external_reference: idInscrito.toString(),
            // IMPORTANTE: Troque 'seu-app' pela URL real do Render quando tiver
            notification_url: `${process.env.BASE_URL_RENDER || 'https://seu-app.onrender.com'}/webhook/pagamento`
        };

        const requestOptions = { idempotencyKey: crypto.randomUUID() };
        const resultMP = await payment.create({ body, requestOptions });
        
        const qrCodeCopiaCola = resultMP.point_of_interaction.transaction_data.qr_code;
        const qrCodeBase64 = resultMP.point_of_interaction.transaction_data.qr_code_base64;
        const mpId = resultMP.id.toString();

        // 3. Atualizar registro com dados do PIX
        await pool.query(
            `UPDATE inscricoes SET mp_id = $1, qr_code = $2, qr_code_base64 = $3 WHERE id = $4`,
            [mpId, qrCodeCopiaCola, qrCodeBase64, idInscrito]
        );

        res.redirect(`/status/${idInscrito}`);

    } catch (error) {
        console.error("Erro na inscrição:", error);
        res.send("Ocorreu um erro ao processar sua inscrição. Tente novamente.");
    }
});

// --- ROTA DE NOTIFICAÇÃO DE PAGAMENTO (WEBHOOK) ---
app.post('/webhook/pagamento', async (req, res) => {
    const { action, data } = req.body;
    console.log("🔔 Webhook recebido:", action, data);

    try {
        if (action === 'payment.created' || action === 'payment.updated') {
             // Precisamos consultar a API para ter certeza do status
             const payment = new Payment(client);
             const infoPagamento = await payment.get({ id: data.id });
             
             const status = infoPagamento.status === 'approved' ? 'Pago' : 'Pendente';
             const idInscrito = infoPagamento.external_reference;

             if (idInscrito) {
                 await pool.query(
                     "UPDATE inscricoes SET status = $1 WHERE id = $2", 
                     [status, idInscrito]
                 );
                 console.log(`✅ Inscrição ${idInscrito} atualizada para: ${status}`);
             }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Erro no Webhook:", error);
        res.status(500).send('Erro');
    }
});

// Status API
app.get('/api/check-status/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT status FROM inscricoes WHERE id = $1", [req.params.id]);
        if(result.rows.length > 0) res.json({ status: result.rows[0].status });
        else res.json({ status: 'Erro' });
    } catch(e) { res.json({ status: 'Erro' }); }
});

// Página de Comprovante
app.get('/status/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM inscricoes WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.send("Não encontrado.");
        res.render('comprovante', { dados: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.send("Erro ao buscar status.");
    }
});

// --- ADMIN (Refatorado para Async/Await) ---
app.get('/admin', verificarAuth, async (req, res) => {
    const filtro = req.query.filtro;
    try {
        let sql = "SELECT * FROM inscricoes";
        let params = [];
        if (filtro) { 
            sql += " WHERE status = $1"; 
            params.push(filtro); 
        }
        sql += " ORDER BY id DESC";

        // Executa todas as consultas em paralelo para ser mais rápido
        const [inscritosRes, galeriaRes, statsRes] = await Promise.all([
            pool.query(sql, params),
            pool.query("SELECT * FROM galeria ORDER BY id DESC"),
            pool.query("SELECT status, sexo FROM inscricoes")
        ]);

        const todos = statsRes.rows;
        const total = todos.length;
        const pagos = todos.filter(r => r.status === 'Pago').length;
        const pendentes = todos.filter(r => r.status === 'Pendente').length;
        const meninos = todos.filter(r => r.sexo === 'Masculino').length;
        const meninas = todos.filter(r => r.sexo === 'Feminino').length;

        res.render('admin', { 
            inscritos: inscritosRes.rows, 
            galeria: galeriaRes.rows, 
            total, pagos, pendentes, meninos, meninas, filtroAtual: filtro 
        });

    } catch (err) {
        console.error("Erro admin:", err);
        res.send("Erro ao carregar admin");
    }
});

app.post('/admin/galeria/adicionar', verificarAuth, upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.redirect('/admin');
    const url = '/uploads/' + req.file.filename; 
    await pool.query("INSERT INTO galeria (tipo, url, titulo) VALUES ($1, $2, $3)", [req.body.tipo, url, req.body.titulo]);
    res.redirect('/admin');
});

app.get('/admin/galeria/deletar/:id', verificarAuth, async (req, res) => {
    await pool.query("DELETE FROM galeria WHERE id = $1", [req.params.id]);
    res.redirect('/admin');
});

// Editar
app.get('/admin/editar/:id', verificarAuth, async (req, res) => {
    const result = await pool.query("SELECT * FROM inscricoes WHERE id = $1", [req.params.id]);
    res.render('editar', { inscrito: result.rows[0] });
});

app.post('/admin/editar/:id', verificarAuth, async (req, res) => {
    const { nome, cpf, sexo, congregacao, telefone, status } = req.body;
    await pool.query(
        `UPDATE inscricoes SET nome=$1, cpf=$2, sexo=$3, congregacao=$4, telefone=$5, status=$6 WHERE id=$7`, 
        [nome, cpf, sexo, congregacao, telefone, status, req.params.id]
    );
    res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});