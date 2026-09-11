// Función programada (cron) — corre sola todos los días, no la llama el front.
// Arma el resumen del día (comida + Whoop) y manda la notificación push.

const webpush = require('web-push');

const JSONBIN_MASTER_KEY = '$2a$10$k.R5Udtn8mYhhnrwn9mPcOpEg/eo937TGhFk48UdrUQx9BRxzfh0W';
const NUTRITION_BIN_ID = '6aa157a0ffd5d16053f1a727';
const GYM_BIN_ID = '6aa157afac6210605ab8076a';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b/';

const WHOOP_CLIENT_ID = '58561d32-d94f-4654-8b76-106f5ae2d6a4';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';

const MODEL = 'claude-sonnet-4-6';
const VAPID_SUBJECT = 'mailto:contacto@nutrym.app';

async function jsonbinGet(binId) {
  const res = await fetch(JSONBIN_BASE + binId + '/latest', { headers: { 'X-Master-Key': JSONBIN_MASTER_KEY } });
  if (!res.ok) throw new Error('jsonbin get ' + res.status);
  const data = await res.json();
  return data.record;
}
async function jsonbinPut(binId, record) {
  const res = await fetch(JSONBIN_BASE + binId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_MASTER_KEY },
    body: JSON.stringify(record)
  });
  if (!res.ok) throw new Error('jsonbin put ' + res.status);
}

function argentinaTodayStr() {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000); // ART = UTC-3, sin horario de verano
  return now.toISOString().slice(0, 10);
}
function getMonday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
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

exports.handler = async () => {
  try {
    const [nutrition, gym] = await Promise.all([jsonbinGet(NUTRITION_BIN_ID), jsonbinGet(GYM_BIN_ID)]);

    if (!gym.pushSubscription) {
      return { statusCode: 200, body: 'sin suscripción push, nada que hacer' };
    }

    const today = argentinaTodayStr();
    const dayData = (nutrition.days && nutrition.days[today]) || { foods: [], activities: [] };
    const intake = (dayData.foods || []).reduce((s, f) => s + Number(f.calories || 0), 0);
    const burned = (dayData.activities || []).reduce((s, a) => s + Number(a.calories || 0), 0);
    const tdee = tdeeForDay(nutrition, today);
    const balance = tdee + burned - intake;
    const foodsCount = (dayData.foods || []).length;

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
        if (recovery && recovery.score) {
          whoopSummary += `Recovery: ${Math.round(recovery.score.recovery_score)}%. `;
        }
        if (sleep && sleep.score) {
          const sleepMs = sleep.score.stage_summary ? sleep.score.stage_summary.total_in_bed_time_milli : null;
          const sleepHrs = sleepMs ? Math.round((sleepMs / 3600000) * 10) / 10 : null;
          if (sleepHrs) whoopSummary += `Dormiste ${sleepHrs}hs. `;
          if (sleep.score.sleep_performance_percentage != null) {
            whoopSummary += `Sleep performance: ${Math.round(sleep.score.sleep_performance_percentage)}%. `;
          }
        }
      }
    }

    let summaryText;
    try {
      const prompt = 'Sos un coach de nutrición y entrenamiento, cercano y directo, que le habla de vos a un usuario argentino. '
        + 'Datos de hoy: consumió ' + intake + ' kcal (' + foodsCount + ' comidas cargadas), su meta de mantenimiento era ' + tdee + ' kcal, quemó ' + burned + ' kcal en actividad. '
        + 'Balance del día: ' + (balance >= 0 ? 'déficit de ' + balance + ' kcal' : 'superávit de ' + Math.abs(balance) + ' kcal') + '. '
        + (whoopSummary ? 'Datos de su Whoop: ' + whoopSummary : 'No tiene datos de Whoop hoy.') + ' '
        + 'Escribí un mensaje de notificación push MUY breve (máximo 2 oraciones cortas, sin saludo, directo al grano) resumiendo cómo le fue hoy y una recomendación concreta para mañana. '
        + 'Si no cargó ninguna comida hoy, decíselo de forma neutral, sin regañar. Respondé SOLO el texto del mensaje, sin comillas, sin JSON.';

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
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
    await jsonbinPut(NUTRITION_BIN_ID, nutrition);

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

    if (gymChanged) await jsonbinPut(GYM_BIN_ID, gym);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    return { statusCode: 500, body: 'error: ' + String(err && err.message || err) };
  }
};
