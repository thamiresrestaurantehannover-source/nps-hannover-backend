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

// Número do administrador que receberá os relatórios (com DDI, sem +)
const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511999999999';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===================== CRIAR TABELA NO SUPABASE =====================
async function initDB() {
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS nps_envios (
        id SERIAL PRIMARY KEY,
        telefone TEXT NOT NULL,
        nome TEXT,
        unidade TEXT,
        data_visita TEXT,
        status TEXT DEFAULT 'enviado',
        nota INTEGER,
        comentario TEXT,
        etapa TEXT DEFAULT 'pesquisa_inicial',
        criado_em TIMESTAMP DEFAULT NOW(),
        respondido_em TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_nps_telefone ON nps_envios(telefone);
      CREATE INDEX IF NOT EXISTS idx_nps_unidade ON nps_envios(unidade);
    `
  });
  if (error) console.log('Tabela já existe ou erro:', error.message);
  else console.log('Tabela nps_envios pronta!');
}

// ===================== ENVIAR MENSAGEM WHATSAPP =====================
async function enviarTemplate(telefone, templateName, params) {
  const components = params && params.length > 0 ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: p }))
  }] : [];

  const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'pt_BR' },
        components: components.length > 0 ? components : undefined
      }
    })
  });

  const data = await res.json();
  if (data.error) console.error('Erro ao enviar template:', data.error);
  return data;
}

async function enviarTexto(telefone, texto) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefone,
      type: 'text',
      text: { body: texto }
    })
  });

  const data = await res.json();
  if (data.error) console.error('Erro ao enviar texto:', data.error);
  return data;
}

// ===================== GERAR RELATÓRIO =====================
async function gerarRelatorio() {
  const { data, error } = await supabase
    .from('nps_envios')
    .select('*')
    .not('nota', 'is', null);

  if (error || !data || data.length === 0) {
    return '📊 Nenhuma resposta registrada ainda.';
  }

  const unidades = {};
  for (const row of data) {
    const u = row.unidade || 'Não informada';
    if (!unidades[u]) unidades[u] = [];
    unidades[u].push(row.nota);
  }

  let relatorio = `📊 *RELATÓRIO NPS HANNOVER*\n📅 ${new Date().toLocaleDateString('pt-BR')}\n\n`;

  for (const [unidade, notas] of Object.entries(unidades)) {
    const total = notas.length;
    const promotores = notas.filter(n => n === 10).length;
    const neutros = notas.filter(n => n === 8 || n === 9).length;
    const detratores = notas.filter(n => n < 8).length;

    const count8 = notas.filter(n => n === 8).length;
    const count9 = notas.filter(n => n === 9).length;
    const count10 = notas.filter(n => n === 10).length;

    const pctPromotor = ((promotores / total) * 100).toFixed(1);
    const pctNeutro = ((neutros / total) * 100).toFixed(1);
    const pctDetrator = ((detratores / total) * 100).toFixed(1);
    const nps = (((promotores - detratores) / total) * 100).toFixed(1);

    relatorio += `🏠 *${unidade}*\n`;
    relatorio += `Total de respostas: ${total}\n`;
    relatorio += `├ Nota 8: ${count8} respostas\n`;
    relatorio += `├ Nota 9: ${count9} respostas\n`;
    relatorio += `└ Nota 10: ${count10} respostas\n\n`;
    relatorio += `😊 Promotores (10): ${promotores} (${pctPromotor}%)\n`;
    relatorio += `😐 Neutros (8-9): ${neutros} (${pctNeutro}%)\n`;
    relatorio += `😞 Detratores (<8): ${detratores} (${pctDetrator}%)\n`;
    relatorio += `⭐ NPS Score: *${nps}*\n\n`;
    relatorio += `─────────────────\n\n`;
  }

  // Total geral
  const todasNotas = data.map(r => r.nota);
  const totalGeral = todasNotas.length;
  const promotoresGeral = todasNotas.filter(n => n === 10).length;
  const detratoresGeral = todasNotas.filter(n => n < 8).length;
  const npsGeral = (((promotoresGeral - detratoresGeral) / totalGeral) * 100).toFixed(1);

  relatorio += `📈 *TOTAL GERAL*\n`;
  relatorio += `Respostas: ${totalGeral}\n`;
  relatorio += `NPS Geral: *${npsGeral}*`;

  return relatorio;
}

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
    const telefone = msg.from;
    const tipo = msg.type;

    let textoRecebido = '';
    if (tipo === 'text') textoRecebido = msg.text?.body?.trim() || '';
    if (tipo === 'button') textoRecebido = msg.button?.text?.trim() || '';
    if (tipo === 'interactive') {
      textoRecebido = msg.interactive?.button_reply?.title?.trim() ||
                      msg.interactive?.list_reply?.title?.trim() || '';
    }

    console.log(`Mensagem de ${telefone}: "${textoRecebido}"`);

    // Comando de relatório (admin)
    if (textoRecebido.toUpperCase().includes('RELATORIO')) {
      const relatorio = await gerarRelatorio();
      await enviarTexto(telefone, relatorio);
      return;
    }

    // Verificar etapa atual do cliente
    const { data: envio } = await supabase
      .from('nps_envios')
      .select('*')
      .eq('telefone', telefone)
      .is('nota', null)
      .order('criado_em', { ascending: false })
      .limit(1)
      .single();

    if (!envio) return;

    // Extrair nota da resposta
    const notaMatch = textoRecebido.match(/\b([0-9]|10)\b/);
    const notaTexto = textoRecebido.includes('Nota 8') ? '8' :
                      textoRecebido.includes('Nota 9') ? '9' :
                      textoRecebido.includes('Nota 10') ? '10' : null;
    const nota = notaTexto ? parseInt(notaTexto) : (notaMatch ? parseInt(notaMatch[1]) : null);

    if (envio.etapa === 'pesquisa_inicial' && nota !== null) {
      // Salvar nota
      await supabase
        .from('nps_envios')
        .update({ nota, etapa: 'respondido', respondido_em: new Date().toISOString() })
        .eq('id', envio.id);

      if (nota === 10) {
        await enviarTemplate(telefone, 'se_responder_10', [envio.nome || 'cliente']);
      } else if (nota === 8 || nota === 9) {
        await enviarTemplate(telefone, 'se_responder_8_ou_9', [envio.nome || 'cliente']);
        await supabase.from('nps_envios').update({ etapa: 'aguardando_comentario' }).eq('id', envio.id);
      }
      return;
    }

    // Receber comentário de quem deu 8 ou 9
    if (envio.etapa === 'aguardando_comentario') {
      await supabase
        .from('nps_envios')
        .update({ comentario: textoRecebido, etapa: 'finalizado' })
        .eq('id', envio.id);

      await enviarTexto(telefone, 'Obrigado pelo seu feedback! Vamos usar sua opinião para melhorar cada vez mais. 💛');
    }

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

// ===================== UPLOAD DE PLANILHA E DISPARO =====================
app.post('/disparar', upload.single('planilha'), async (req, res) => {
  try {
    const buffer = req.file.buffer;
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    let enviados = 0;
    let erros = 0;

    for (const row of rows) {
      const nome = row['nome'] || row['Nome'] || row['NOME'] || '';
      let telefone = String(row['telefone'] || row['Telefone'] || row['TELEFONE'] || '').replace(/\D/g, '');
      const unidade = row['unidade'] || row['Unidade'] || row['UNIDADE'] || '';
      const dataVisita = row['data_visita'] || row['Data da Visita'] || row['DATA_VISITA'] || '';

      if (!telefone) { erros++; continue; }

      // Garantir DDI 55
      if (!telefone.startsWith('55')) telefone = '55' + telefone;

      try {
        // Salvar no Supabase
        await supabase.from('nps_envios').insert({
          telefone,
          nome,
          unidade,
          data_visita: dataVisita,
          status: 'enviado',
          etapa: 'pesquisa_inicial'
        });

        // Enviar template
        await enviarTemplate(telefone, 'pesquisa_inicial', [nome]);
        enviados++;

        // Aguardar 1 segundo entre envios para não ser bloqueado
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error('Erro ao enviar para', telefone, e);
        erros++;
      }
    }

    res.json({ sucesso: true, enviados, erros });
  } catch (err) {
    console.error('Erro no upload:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ===================== ENDPOINT DE RESULTADOS =====================
app.get('/resultados', async (req, res) => {
  const { data, error } = await supabase
    .from('nps_envios')
    .select('*')
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

app.get('/', (req, res) => res.send('NPS Backend rodando!'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`NPS Backend rodando na porta ${PORT}`);
  await initDB();
});
