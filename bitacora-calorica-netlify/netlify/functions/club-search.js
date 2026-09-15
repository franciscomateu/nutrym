// Busca clubes deportivos por nombre en TheSportsDB (base gratuita y pública)
// y devuelve el nombre + la URL de su escudo real. No usa IA ni consume el
// cupo diario de Anthropic.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const q = ((event.queryStringParameters && event.queryStringParameters.q) || '').trim();
  if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el parámetro q' }) };

  try {
    const res = await fetch('https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('TheSportsDB respondió ' + res.status);
    const data = await res.json();
    const teams = (data.teams || []).slice(0, 8).map(t => ({
      name: t.strTeam,
      badgeUrl: t.strTeamBadge || null,
      sport: t.strSport || null,
      country: t.strCountry || null
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ teams }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
