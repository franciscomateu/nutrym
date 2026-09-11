// Intermediaria OAuth2 con la API de Whoop.
// El Client Secret vive solo acá (variable de entorno de Netlify), nunca en el navegador.

const CLIENT_ID = '58561d32-d94f-4654-8b76-106f5ae2d6a4';
const REDIRECT_URI = 'https://nutrym.netlify.app/';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API_BASE = 'https://api.prod.whoop.com/developer/v2';

// Lee la respuesta como texto primero, y solo intenta parsear JSON si corresponde.
// Así, si Whoop devuelve HTML/texto plano (error de gateway, 404, etc.), no explota
// y en cambio devuelve el texto crudo para poder diagnosticar.
async function safeReadResponse(res) {
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
  return { data, raw };
}
function whoopErrorMessage(status, data, raw, label) {
  if (data && (data.error_description || data.error || data.message)) {
    return label + ' (HTTP ' + status + '): ' + (data.error_description || data.error || data.message);
  }
  const snippet = (raw || '').slice(0, 200);
  return label + ' (HTTP ' + status + '): ' + (snippet || 'sin cuerpo de respuesta');
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  if (!process.env.WHOOP_CLIENT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Falta configurar WHOOP_CLIENT_SECRET en Netlify' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    if (payload.action === 'exchange') {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: payload.code,
        client_id: CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const { data, raw } = await safeReadResponse(res);
      if (!res.ok || !data) return { statusCode: 502, headers, body: JSON.stringify({ error: whoopErrorMessage(res.status, data, raw, 'Whoop (exchange)') }) };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (payload.action === 'refresh') {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: payload.refreshToken,
        client_id: CLIENT_ID,
        client_secret: process.env.WHOOP_CLIENT_SECRET,
        scope: 'offline'
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const { data, raw } = await safeReadResponse(res);
      if (!res.ok || !data) return { statusCode: 502, headers, body: JSON.stringify({ error: whoopErrorMessage(res.status, data, raw, 'Whoop (refresh)') }) };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (payload.action === 'workouts') {
      const params = new URLSearchParams({ limit: '25' });
      if (payload.start) params.set('start', payload.start);
      const res = await fetch(API_BASE + '/activity/workout?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + payload.accessToken }
      });
      const { data, raw } = await safeReadResponse(res);
      if (!res.ok || !data) return { statusCode: 502, headers, body: JSON.stringify({ error: whoopErrorMessage(res.status, data, raw, 'Whoop (workouts)') }) };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción desconocida' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno de la función: ' + String(err && err.message || err) }) };
  }
};
