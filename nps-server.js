const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// ===================== CONFIGURAÇÕES =====================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hannover_nps_2026';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===================== WEBHOOK VERIFICAÇÃO =====================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===================== WEBHOOK RECEBER MENSAGENS =====================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body?.trim();

    if (!text) return;

    console.log(`Mensagem recebida de ${from}: ${text}`);

    const { data: envio } = await supabase
      .from('nps_envios')
      .select('*')
      .eq('telefone', from)
      .eq('status', 'aguardando_nota')
      .single();

    if (envio) {
      const nota = parseInt(text);
      if ([8, 9, 10].includes(nota)) {
        await supabase.from('nps_envios').update({
          nota,
          status: nota === 10 ? 'concluido' : 'aguardando_comentario',
          respondido_em: new Date().toISOString()
        }).eq('id', envio.id);

        if (nota === 10) {
          await enviarTemplate(from, envio.nome, 'se_responder_10');
        } else {
          await enviarTemplate(from, envio.nome, 'se_responder_8_ou_9');
        }
      }
      return;
    }

    const { data: envioComentario } = await supabase
      .from('nps_envios')
      .select('*')
      .eq('telefone', from)
      .eq('status', 'aguardando_comentario')
      .single();

    if (envioComentario) {
      await supabase.from('nps_envios').update({
        comentario: text,
        status: 'concluido'
      }).eq('id', envioComentario.id);
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

// ===================== FUNÇÃO ENVIAR TEMPLATE =====================
async function enviarTemplate(telefone, nome, templateName) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'pt_BR' },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: nome }]
        }
      ]
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  console.log(`Template ${templateName} enviado para ${telefone}:`, result);
  return result;
}

// ===================== UPLOAD PLANILHA E DISPARO =====================
app.post('/disparar', upload.single('planilha'), async (req, res) => {
  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    const resultados = [];

    for (const row of rows) {
      const nome = row['nome'] || row['Nome'] || row['NOME'];
      let telefone = String(row['telefone'] || row['Telefone'] || row['TELEFONE'] || '').replace(/\D/g, '');

      if (!nome || !telefone) continue;

      if (telefone.startsWith('0')) telefone = telefone.slice(1);
      if (!telefone.startsWith('55')) telefone = '55' + telefone;

      const { data: envio, error } = await supabase.from('nps_envios').insert({
        nome,
        telefone,
        status: 'aguardando_nota',
        enviado_em: new Date().toISOString()
      }).select().single();

      if (error) {
        resultados.push({ nome, telefone, status: 'erro', detalhe: error.message });
        continue;
      }

      const resultado = await enviarTemplate(telefone, nome, 'pesquisa_inicial');
      resultados.push({ nome, telefone, status: resultado.messages ? 'enviado' : 'erro' });

      await new Promise(r => setTimeout(r, 300));
    }

    res.json({ total: resultados.length, resultados });
  } catch (err) {
    console.error('Erro no disparo:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ===================== RESULTADOS NPS =====================
app.get('/resultados', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nps_envios')
      .select('*')
      .not('nota', 'is', null);

    if (error) throw error;

    const total = data.length;
    const promotores = data.filter(d => d.nota === 10).length;
    const neutros = data.filter(d => d.nota === 9).length;
    const detratores = data.filter(d => d.nota === 8).length;

    const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';

    res.json({
      total,
      promotores: { quantidade: promotores, percentual: pct(promotores) },
      neutros: { quantidade: neutros, percentual: pct(neutros) },
      detratores: { quantidade: detratores, percentual: pct(detratores) },
      registros: data
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ===================== HEALTH CHECK =====================
app.get('/', (req, res) => {
  res.json({ ok: true, servico: 'NPS Hannover', status: 'online' });
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NPS Backend rodando na porta ${PORT}`));
