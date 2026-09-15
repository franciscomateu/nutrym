// Recibe datos de Apple Health desde un Atajo de iOS (Shortcuts) y los guarda.
// No hay API web de Apple Health — este es el único camino real: un Atajo que
// corre en el propio iPhone y le pega a esta función con los datos del día.
// Fase 3 multi-usuario: el token ahora es el user_id de Supabase de cada persona
// (lo ve en Configuración de la app), así el Atajo de cada uno escribe solo en
// su propia cuenta.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function isValidUser(userId) {
  const res = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  return res.ok;
}
async function sbGetNutrition(userId) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/user_data?domain=eq.nutrition&user_id=eq.' + userId + '&select=data', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!res.ok) throw new Error('supabase get nutrition: ' + res.status);
  const rows = await res.json();
  return rows[0] ? rows[0].data : {};
}
async function sbPutNutrition(userId, data) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/user_data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ user_id: userId, domain: 'nutrition', data, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error('supabase put nutrition: ' + res.status);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Health-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en Netlify' }) };
  }

  const userId = event.headers['x-health-token'] || event.headers['X-Health-Token'];
  if (!userId || !(await isValidUser(userId))) {
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
    const nutrition = await sbGetNutrition(userId);
    if (!nutrition.appleHealth) nutrition.appleHealth = {};
    nutrition.appleHealth[date] = {
      steps: payload.steps != null ? Math.round(Number(payload.steps)) : null,
      activeEnergyKcal: payload.activeEnergyKcal != null ? Math.round(Number(payload.activeEnergyKcal)) : null,
      syncedAt: new Date().toISOString()
    };
    await sbPutNutrition(userId, nutrition);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno: ' + String(err && err.message || err) }) };
  }
};
