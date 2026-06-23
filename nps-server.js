async function enviarTemplate(telefone, templateName, params) {
  const components = params && params.length > 0 ? [{
    type: 'body',
    parameters: params.map(p => ({ type: 'text', text: p }))
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
