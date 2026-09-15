// Función programada (cron) — corre sola todos los días, no la llama el front.
// Recorre a TODOS los usuarios (Fase 3 multi-usuario), arma el resumen del día
// de cada uno (comida + Whoop) y le manda su propia notificación push.

const webpush = require('web-push');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const WHOOP_CLIENT_ID = '58561d32-d94f-4654-8b76-106f5ae2d6a4';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';

const MODEL = 'claude-sonnet-4-6';
const VAPID_SUBJECT = 'mailto:contacto@nutrym.app';

async function sbGetAll(domain) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/user_data?domain=eq.' + domain + '&select=user_id,data', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!res.ok) throw new Error('supabase get ' + domain + ': ' + res.status);
  return res.json();
}
async function sbPut(userId, domain, data) {
  await fetch(SUPABASE_URL + '/rest/v1/user_data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ user_id: userId, domain, data, updated_at: new Date().toISOString() })
  });
}

function argentinaTodayStr() {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}
function tdeeForDay(nutrition, dateStr) {
  const dayEntry = nutrition.days && nutrition.days[dateStr];
  const type = (dayEntry && dayEntry.dayType) || (() => {
    const d = new Date(dateStr + 'T00:00:00Z');
    const dow = d.getUTCDay();
    return (dow === 0 || dow === 6) ? 'activo' : 'sedentario';
  })();
  const s = nutrition.settings || {};
  if (type === 'activo') return s.tdeeActivo || 2500;
  if (type === 'intermedio') return s.tdeeIntermedio || 2350;
  return s.tdeeSedentario || 2200;
}

async function whoopEnsureValidToken(gym) {
  if (!gym.whoop) return null;
  if (Date.now() < gym.whoop.expiresAt) return gym.whoop.accessToken;
  if (!process.env.WHOOP_CLIENT_SECRET) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: gym.whoop.refreshToken,
    client_id: WHOOP_CLIENT_ID,
    client_secret: process.env.WHOOP_CLIENT_SECRET,
    scope: 'offline'
  });
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) return null;
  const tokens = await res.json();
  gym.whoop = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || gym.whoop.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 - 60000
  };
  return gym.whoop.accessToken;
}

async function fetchWhoopLatest(path, accessToken) {
  try {
    const res = await fetch(WHOOP_API_BASE + path + '?limit=1', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.records && data.records[0]) || null;
  } catch (e) {
    return null;
  }
}

async function processUser(userId, nutrition, gym) {
  if (!gym.pushSubscription) return { nutritionChanged: false, gymChanged: false };

  const today = argentinaTodayStr();
  const dayData = (nutrition.days && nutrition.days[today]) || { foods: [], activities: [] };
  const intake = (dayData.foods || []).reduce((s, f) => s + Number(f.calories || 0), 0);
  const burned = (dayData.activities || []).reduce((s, a) => s + Number(a.calories || 0), 0);
  const tdee = tdeeForDay(nutrition, today);
  const balance = tdee + burned - intake;
  const foodsCount = (dayData.foods || []).length;

  let patternNote = '';
  const past7 = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(new Date(today + 'T00:00:00Z').getTime() - i * 86400000).toISOString().slice(0, 10);
    const dd = nutrition.days && nutrition.days[d];
    if (dd && dd.foods && dd.foods.length) {
      const in_ = dd.foods.reduce((s, f) => s + Number(f.calories || 0), 0);
      const out_ = (dd.activities || []).reduce((s, a) => s + Number(a.calories || 0), 0);
      past7.push(tdeeForDay(nutrition, d) + out_ - in_);
    }
  }
  const consecutiveSurplus = (() => {
    let count = 0;
    for (const b of past7) { if (b < 0) count++; else break; }
    return count;
  })();
  if (consecutiveSurplus >= 3) patternNote += `Lleva ${consecutiveSurplus} días seguidos en superávit (contando hoy si corresponde). `;
  const wdates = Object.keys(nutrition.weights || {}).sort();
  if (wdates.length) {
    const daysSinceWeight = Math.round((new Date(today) - new Date(wdates[wdates.length - 1])) / 86400000);
    if (daysSinceWeight >= 14) patternNote += `No registra su peso hace ${daysSinceWeight} días. `;
  } else {
    patternNote += 'Nunca cargó su peso. ';
  }

  let whoopSummary = '';
  let gymChanged = false;
  if (gym.whoop) {
    const token = await whoopEnsureValidToken(gym);
    if (token) {
      gymChanged = true;
      const [recovery, sleep] = await Promise.all([
        fetchWhoopLatest('/recovery', token),
        fetchWhoopLatest('/activity/sleep', token)
      ]);
      let recoveryScoreToday = null, sleepHrsToday = null;
      if (recovery && recovery.score) {
        recoveryScoreToday = Math.round(recovery.score.recovery_score);
        whoopSummary += `Recovery: ${recoveryScoreToday}%. `;
      }
      if (sleep && sleep.score) {
        const sleepMs = sleep.score.stage_summary ? sleep.score.stage_summary.total_in_bed_time_milli : null;
        sleepHrsToday = sleepMs ? Math.round((sleepMs / 3600000) * 10) / 10 : null;
        if (sleepHrsToday) whoopSummary += `Dormiste ${sleepHrsToday}hs. `;
        if (sleep.score.sleep_performance_percentage != null) {
          whoopSummary += `Sleep performance: ${Math.round(sleep.score.sleep_performance_percentage)}%. `;
        }
      }
      if (recoveryScoreToday != null || sleepHrsToday != null) {
        if (!gym.whoopHistory) gym.whoopHistory = {};
        gym.whoopHistory[today] = { recoveryScore: recoveryScoreToday, sleepHours: sleepHrsToday };
        gymChanged = true;
      }
    }
  }

  let summaryText;
  try {
    const prompt = 'Sos un coach de nutrición y entrenamiento, cercano y directo, que le habla de vos a un usuario argentino. '
      + 'Datos de hoy: consumió ' + intake + ' kcal (' + foodsCount + ' comidas cargadas), su meta de mantenimiento era ' + tdee + ' kcal, quemó ' + burned + ' kcal en actividad. '
      + 'Balance del día: ' + (balance >= 0 ? 'déficit de ' + balance + ' kcal' : 'superávit de ' + Math.abs(balance) + ' kcal') + '. '
      + (whoopSummary ? 'Datos de su Whoop: ' + whoopSummary : 'No tiene datos de Whoop hoy.') + ' '
      + (patternNote ? 'Patrones detectados en sus datos: ' + patternNote + 'Si alguno de estos patrones es relevante, mencionalo con tacto (sin regañar, como un entrenador que te conoce). ' : '')
      + 'Escribí un mensaje de notificación push breve (máximo 2 oraciones cortas, sin saludo, directo al grano) resumiendo cómo le fue hoy, mencionando el patrón detectado si hay uno relevante, y una recomendación concreta para mañana. '
      + 'Si no cargó ninguna comida hoy, decíselo de forma neutral, sin regañar. Respondé SOLO el texto del mensaje, sin comillas, sin JSON.';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    });
    const aiData = await aiRes.json();
    const textBlock = (aiData.content || []).find(b => b.type === 'text');
    summaryText = textBlock ? textBlock.text.trim() : null;
  } catch (e) {
    summaryText = null;
  }
  if (!summaryText) {
    summaryText = foodsCount === 0
      ? 'Todavía no cargaste comidas hoy.'
      : (balance >= 0 ? `Cerraste con déficit de ${balance} kcal.` : `Cerraste con superávit de ${Math.abs(balance)} kcal.`);
  }

  if (!nutrition.dailySummaries) nutrition.dailySummaries = {};
  nutrition.dailySummaries[today] = {
    text: summaryText,
    intake, burned, tdee, balance,
    whoopSummary: whoopSummary || null,
    generatedAt: new Date().toISOString(),
    seen: false
  };

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    try {
      await webpush.sendNotification(gym.pushSubscription, JSON.stringify({
        title: 'Tu resumen de hoy',
        body: summaryText,
        url: '/'
      }));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        gym.pushSubscription = null;
        gymChanged = true;
      }
    }
  }

  return { nutritionChanged: true, gymChanged };
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en Netlify' };
  }
  try {
    const [nutritionRows, gymRows] = await Promise.all([sbGetAll('nutrition'), sbGetAll('gym')]);
    const gymByUser = {};
    gymRows.forEach(r => { gymByUser[r.user_id] = r.data; });

    let processed = 0;
    for (const row of nutritionRows) {
      const userId = row.user_id;
      const nutrition = row.data;
      const gym = gymByUser[userId];
      if (!gym) continue;

      const { nutritionChanged, gymChanged } = await processUser(userId, nutrition, gym);
      if (nutritionChanged) await sbPut(userId, 'nutrition', nutrition);
      if (gymChanged) await sbPut(userId, 'gym', gym);
      if (nutritionChanged || gymChanged) processed++;
    }

    return { statusCode: 200, body: 'ok, usuarios procesados: ' + processed };
  } catch (err) {
    return { statusCode: 500, body: 'error: ' + String(err && err.message || err) };
  }
};
