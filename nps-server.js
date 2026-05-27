const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Banco de dados ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Criar tabela automaticamente na primeira vez ─────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nps_respostas (
      id SERIAL PRIMARY KEY,
      nome TEXT,
      telefone TEXT NOT NULL,
      unidade TEXT,
      nota INTEGER,
      tipo TEXT,
      comentario TEXT,
      aguardando_comentario BOOLEAN DEFAULT FALSE,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nps_clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT,
      telefone TEXT NOT NULL,
      unidade TEXT,
      status TEXT DEFAULT 'pendente',
      enviado_em TIMESTAMP
    );
  `);

  console.log("✅ Tabelas NPS criadas/verificadas com sucesso.");
}

// ─── Z-API: Configurações ─────────────────────────────────────────────────────
const ZAPI_INSTANCE    = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN       = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

async function enviarWhatsApp(telefone, mensagem) {
  const digits = String(telefone).replace(/\D/g, "");
  const phone  = digits.startsWith("55") ? digits : `55${digits}`;

  const res = await fetch(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": ZAPI_CLIENT_TOKEN,
      },
      body: JSON.stringify({ phone, message: mensagem }),
    }
  );
  return res.json();
}

function classificarNPS(nota) {
  if (nota >= 9) return "promotor";
  if (nota >= 7) return "neutro";
  return "detrator";
}

// ─── WEBHOOK Z-API ────────────────────────────────────────────────────────────
// Configurar na Z-API: Webhooks > "Ao receber" > URL deste endpoint
app.post("/webhook/zapi", async (req, res) => {
  try {
    const body = req.body;

    // Z-API envia mensagens recebidas nesse formato
    const mensagem = body?.text?.message || body?.message || "";
    const telefone = body?.phone || body?.from || "";

    if (!telefone || !mensagem) return res.sendStatus(200);

    // Ignora mensagens enviadas por nós mesmos
    if (body?.fromMe) return res.sendStatus(200);

    const telefoneLimpo = String(telefone).replace(/\D/g, "").replace(/^55/, "");
    const texto = String(mensagem).trim();

    console.log(`📩 Mensagem recebida de ${telefoneLimpo}: "${texto}"`);

    // ── Verifica se cliente está aguardando comentário (após nota 8 ou 9) ──
    const aguardando = await pool.query(
      `SELECT * FROM nps_respostas 
       WHERE telefone LIKE $1 AND aguardando_comentario = TRUE 
       ORDER BY criado_em DESC LIMIT 1`,
      [`%${telefoneLimpo}`]
    );

    if (aguardando.rows.length > 0) {
      const resposta = aguardando.rows[0];
      await pool.query(
        `UPDATE nps_respostas SET comentario = $1, aguardando_comentario = FALSE WHERE id = $2`,
        [texto, resposta.id]
      );

      await enviarWhatsApp(
        telefone,
        `Obrigado pelo seu comentário! 🙏\nSua opinião é muito importante para o *Hannover ${resposta.unidade}*. Esperamos te ver em breve! 😊`
      );

      console.log(`💬 Comentário salvo para ${resposta.nome}: "${texto}"`);
      return res.sendStatus(200);
    }

    // ── Verifica se é uma nota NPS (número de 0 a 10) ──
    const nota = parseInt(texto);
    if (isNaN(nota) || nota < 0 || nota > 10) {
      return res.sendStatus(200); // Ignora mensagens que não são notas
    }

    // Busca o cliente pelo telefone na tabela de clientes enviados
    const clienteResult = await pool.query(
      `SELECT * FROM nps_clientes WHERE telefone LIKE $1 ORDER BY enviado_em DESC LIMIT 1`,
      [`%${telefoneLimpo}`]
    );

    const cliente = clienteResult.rows[0];
    const nome    = cliente?.nome    || "Cliente";
    const unidade = cliente?.unidade || "Hannover";
    const tipo    = classificarNPS(nota);

    // Salva a resposta
    await pool.query(
      `INSERT INTO nps_respostas (nome, telefone, unidade, nota, tipo, aguardando_comentario)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [nome, telefoneLimpo, unidade, nota, tipo, nota === 8 || nota === 9]
    );

    console.log(`✅ Nota ${nota} (${tipo}) salva para ${nome} - ${unidade}`);

    // ── Resposta automática por tipo ──
    if (nota >= 9) {
      // Promotor
      await enviarWhatsApp(
        telefone,
        `Que incrível! Nota *${nota}* para o Hannover ${unidade}! 🎉\n\nFicamos muito felizes com sua avaliação! Você tem algum elogio ou comentário que queira deixar? ✍️`
      );
    } else if (nota === 8 || nota === 7) {
      // Neutro com follow-up
      await enviarWhatsApp(
        telefone,
        `Obrigado pela sua nota *${nota}*! 😊\n\nPoderia nos contar o que poderíamos melhorar no Hannover ${unidade}? Sua opinião nos ajuda a crescer! ✍️`
      );
    } else {
      // Detrator (0-6)
      await enviarWhatsApp(
        telefone,
        `Agradecemos sua honestidade com a nota *${nota}*. 😔\n\nNos conte o que aconteceu para que possamos melhorar. Sua experiência é muito importante para nós! ✍️`
      );

      // Envia notificação interna para número de alerta (opcional)
      if (process.env.TELEFONE_ALERTA) {
        await enviarWhatsApp(
          process.env.TELEFONE_ALERTA,
          `⚠️ *Alerta NPS — Detrator*\n\nCliente: ${nome}\nTelefone: ${telefoneLimpo}\nUnidade: ${unidade}\nNota: ${nota}\n\nAcompanhe pelo painel!`
        );
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    return res.sendStatus(500);
  }
});

// ─── API: Buscar respostas ─────────────────────────────────────────────────────
app.get("/nps/respostas", async (req, res) => {
  try {
    const { unidade } = req.query;

    let query = `SELECT * FROM nps_respostas ORDER BY criado_em DESC`;
    let params = [];

    if (unidade && unidade !== "Todas") {
      query  = `SELECT * FROM nps_respostas WHERE unidade = $1 ORDER BY criado_em DESC`;
      params = [unidade];
    }

    const result = await pool.query(query, params);
    res.json({ ok: true, respostas: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── API: Resumo NPS por unidade ──────────────────────────────────────────────
app.get("/nps/resumo", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        unidade,
        COUNT(*) AS total,
        SUM(CASE WHEN nota >= 9 THEN 1 ELSE 0 END) AS promotores,
        SUM(CASE WHEN nota >= 7 AND nota <= 8 THEN 1 ELSE 0 END) AS neutros,
        SUM(CASE WHEN nota <= 6 THEN 1 ELSE 0 END) AS detratores,
        ROUND(
          (SUM(CASE WHEN nota >= 9 THEN 1 ELSE 0 END)::decimal -
           SUM(CASE WHEN nota <= 6 THEN 1 ELSE 0 END)::decimal)
          / COUNT(*) * 100
        ) AS nps_score
      FROM nps_respostas
      GROUP BY unidade
    `);

    res.json({ ok: true, resumo: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── API: Salvar cliente enviado ──────────────────────────────────────────────
app.post("/nps/clientes", async (req, res) => {
  try {
    const { clientes } = req.body; // array de { nome, telefone, unidade }

    if (!clientes || !clientes.length) {
      return res.status(400).json({ ok: false, erro: "Nenhum cliente enviado." });
    }

    for (const c of clientes) {
      await pool.query(
        `INSERT INTO nps_clientes (nome, telefone, unidade, status, enviado_em)
         VALUES ($1, $2, $3, 'enviado', NOW())
         ON CONFLICT DO NOTHING`,
        [c.nome, String(c.telefone).replace(/\D/g, ""), c.unidade]
      );
    }

    res.json({ ok: true, salvos: clientes.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, servico: "NPS Hannover Backend", status: "online" });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 NPS Server rodando na porta ${PORT}`);
  await initDB();
});
