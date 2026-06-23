const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const xlsx = require('xlsx');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'hannover_nps_2026';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function enviarTemplate(telefone, templateName, params) {
  const components = params && params.length > 0 ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: String(p) }))
  }] : [];

  const body = {
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'pt_BR' },
      components: components.length > 0 ? components : undefined
    }
  };

  console.log('Enviando para:', telefone, JSON.stringify(body));

  const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  console.log('Resposta Meta:', JSON.stringify(data));
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

async function gerarRelatorio() {
  const { data, error } = await supabase
    .from('nps_envios')
    .select('*')
    .not('nota', 'is', null);

  if (error || !data || data.length === 0) return '📊 Nenhuma resposta registrada ainda.';

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
    const nps = (((promotores - detratores) / total) * 100).toFixed(1);

    relatorio += `🏠 *${unidade}*\n`;
    relatorio += `Total: ${total} respostas\n`;
    relatorio += `├ Nota 8: ${count8}\n├ Nota 9: ${count9}\n└ Nota 10: ${count10}\n\n`;
    relatorio += `😊 Promotores (10): ${promotores} (${((promotores/total)*100).toFixed(1)}%)\n`;
    relatorio += `😐 Neutros (8-9): ${neutros} (${((neutros/total)*100).toFixed(1)}%)\n`;
    relatorio += `😞 Detratores (<8): ${detratores} (${((detratores/total)*100).toFixed(1)}%)\n`;
    relatorio += `⭐ NPS Score: *${nps}*\n\n─────────────────\n\n`;
  }

  const todasNotas = data.map(r => r.nota);
  const totalGeral = todasNotas.length;
  const promGeral = todasNotas.filter(n => n === 10).length;
  const detGeral = todasNotas.filter(n => n < 8).length;
  const npsGeral = (((promGeral - detGeral) / totalGeral) * 100).toFixed(1);
  relatorio += `📈 *TOTAL GERAL*\nRespostas: ${totalGeral}\nNPS Geral: *${npsGeral}*`;

  return relatorio;
}

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

    if (textoRecebido.toUpperCase().includes('RELATORIO')) {
      const relatorio = await gerarRelatorio();
      await enviarTexto(telefone, relatorio);
      return;
    }

    const { data: envio } = await supabase
      .from('nps_envios')
      .select('*')
      .eq('telefone', telefone)
      .is('nota', null)
      .order('criado_em', { ascending: false })
      .limit(1)
      .single();

    if (!envio) return;

    const notaTexto = textoRecebido.includes('Nota 8') ? '8' :
                      textoRecebido.includes('Nota 9') ? '9' :
                      textoRecebido.includes('Nota 10') ? '10' : null;
    const notaMatch = textoRecebido.match(/\b(10|[89])\b/);
    const nota = notaTexto ? parseInt(notaTexto) : (notaMatch ? parseInt(notaMatch[1]) : null);

    if (envio.etapa === 'pesquisa_inicial' && nota !== null) {
      await supabase.from('nps_envios')
        .update({ nota, etapa: nota === 8 || nota === 9 ? 'aguardando_comentario' : 'respondido', respondido_em: new Date().toISOString() })
        .eq('id', envio.id);

      if (nota === 10) {
        await enviarTemplate(telefone, 'se_responder_10', [envio.nome || 'cliente']);
      } else if (nota === 8 || nota === 9) {
        await enviarTemplate(telefone, 'se_responder_8_ou_9', [envio.nome || 'cliente']);
      }
      return;
    }

    if (envio.etapa === 'aguardando_comentario') {
      await supabase.from('nps_envios')
        .update({ comentario: textoRecebido, etapa: 'finalizado' })
        .eq('id', envio.id);
      await enviarTexto(telefone, 'Obrigado pelo seu feedback! Vamos usar sua opinião para melhorar cada vez mais. 💛');
    }
  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

app.post('/disparar', upload.single('planilha'), async (req, res) => {
  try {
    const buffer = req.file.buffer;
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    let enviados = 0;
    let erros = 0;

    for (const row of rows) {
      const nome = String(row['nome'] || row['Nome'] || row['NOME'] || '').trim();
      let telefone = String(row['telefone'] || row['Telefone'] || row['TELEFONE'] || '').replace(/\D/g, '');
      const unidade = String(row['unidade'] || row['Unidade'] || row['UNIDADE'] || '').trim();
      const dataVisita = String(row['data_visita'] || row['Data da Visita'] || row['DATA_VISITA'] || '').trim();

      if (!telefone) { erros++; continue; }
      if (!telefone.startsWith('55')) telefone = '55' + telefone;

      try {
        await supabase.from('nps_envios').insert({
          telefone, nome, unidade, data_visita: dataVisita,
          status: 'enviado', etapa: 'pesquisa_inicial'
        });
        const resultado = await enviarTemplate(telefone, 'pesquisa_inicial', [nome]);
        if (resultado.error) {
          console.error('Erro Meta para', telefone, resultado.error);
          erros++;
        } else {
          enviados++;
        }
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
});
