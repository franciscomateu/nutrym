// Recibe datos de Apple Health desde un Atajo de iOS (Shortcuts) y los guarda.
// No hay API web de Apple Health — este es el único camino real: un Atajo que
// corre en el propio iPhone y le pega a esta función con los datos del día.

const JSONBIN_MASTER_KEY = '$2a$10$k.R5Udtn8mYhhnrwn9mPcOpEg/eo937TGhFk48UdrUQx9BRxzfh0W';
const NUTRITION_BIN_ID = '6aa157a0ffd5d16053f1a727';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b/';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Health-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  const token = event.headers['x-health-token'] || event.headers['X-Health-Token'];
  if (!process.env.HEALTH_WEBHOOK_TOKEN || token !== process.env.HEALTH_WEBHOOK_TOKEN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  const date = payload.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta o es inválida la fecha (formato YYYY-MM-DD)' }) };
  }

  try {
    const res = await fetch(JSONBIN_BASE + NUTRITION_BIN_ID + '/latest', { headers: { 'X-Master-Key': JSONBIN_MASTER_KEY } });
    if (!res.ok) throw new Error('jsonbin get ' + res.status);
    const data = await res.json();
    const nutrition = data.record;

    if (!nutrition.appleHealth) nutrition.appleHealth = {};
    nutrition.appleHealth[date] = {
      steps: payload.steps != null ? Math.round(Number(payload.steps)) : null,
      activeEnergyKcal: payload.activeEnergyKcal != null ? Math.round(Number(payload.activeEnergyKcal)) : null,
      syncedAt: new Date().toISOString()
    };

    const putRes = await fetch(JSONBIN_BASE + NUTRITION_BIN_ID, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_MASTER_KEY },
      body: JSON.stringify(nutrition)
    });
    if (!putRes.ok) throw new Error('jsonbin put ' + putRes.status);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno: ' + String(err && err.message || err) }) };
  }
};
