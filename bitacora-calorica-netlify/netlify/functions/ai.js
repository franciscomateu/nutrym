// Función serverless: intermediaria entre el front y la API de Anthropic.
// La API key vive solo acá (variable de entorno de Netlify), nunca en el navegador.
// Un token compartido simple (APP_TOKEN) evita que alguien que encuentre la URL
// de esta función te consuma la cuota sin tu conocimiento. Además, cada usuario
// logueado tiene un límite diario propio de uso de IA (Fase 2 multi-usuario).

const MODEL = 'claude-sonnet-4-6';
const PHOTO_DAILY_LIMIT = Number(process.env.PHOTO_DAILY_LIMIT) || 15;
const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT) || 30;

async function getSupabaseUser(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.id ? data : null;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
async function getUsage(userId) {
  const res = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/ai_usage?user_id=eq.' + userId + '&date=eq.' + todayStr() + '&select=photo_calls,chat_calls',
    { headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY } }
  );
  if (!res.ok) return { photo_calls: 0, chat_calls: 0 };
  const rows = await res.json();
  return rows[0] || { photo_calls: 0, chat_calls: 0 };
}
async function incrementUsage(userId, bucket, current) {
  const row = { user_id: userId, date: todayStr(), photo_calls: current.photo_calls || 0, chat_calls: current.chat_calls || 0 };
  row[bucket] = (row[bucket] || 0) + 1;
  await fetch(process.env.SUPABASE_URL + '/rest/v1/ai_usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  }).catch(() => {});
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const token = event.headers['x-app-token'] || event.headers['X-App-Token'];
  if (!process.env.APP_TOKEN || token !== process.env.APP_TOKEN) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No autorizado' }) };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Falta configurar ANTHROPIC_API_KEY en Netlify' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const user = await getSupabaseUser(authHeader);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sesión inválida — volvé a iniciar sesión' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  const bucket = payload.action === 'foto' ? 'photo_calls' : 'chat_calls';
  const limit = payload.action === 'foto' ? PHOTO_DAILY_LIMIT : CHAT_DAILY_LIMIT;
  const usage = await getUsage(user.id);
  if ((usage[bucket] || 0) >= limit) {
    const label = bucket === 'photo_calls' ? 'de análisis de fotos' : 'de uso de IA';
    return { statusCode: 429, headers, body: JSON.stringify({ error: `Llegaste al límite diario ${label} (${limit}/día). Probá de nuevo mañana.` }) };
  }

  let messages;
  if (payload.action === 'foto') {
    if (!payload.image) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta la imagen' }) };
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: payload.mediaType || 'image/jpeg', data: payload.image } },
        {
          type: 'text',
          text: 'Sos un nutricionista. Mirá esta foto de comida. Identificá el plato y separá el componente PRINCIPAL más difícil de estimar a ojo (generalmente la proteína: carne, pollo, pescado, milanesa, etc. — el que más varía en tamaño real) del resto de los acompañamientos (arroz, puré, ensalada, guarniciones), que sí podés estimar con más certeza a partir de la imagen. '
            + 'Para el componente principal, dame 3 opciones de tamaño usando referencias intuitivas y cotidianas (media palma de la mano, un puño cerrado, más grande que un puño, o similar — elegí las 3 referencias que más sentido tengan para ESE alimento puntual), cada una con su estimación de gramos y macros. Indicá cuál de las 3 te parece la más probable según lo que ves en la foto. '
            + 'Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown) con esta forma exacta: '
            + '{"name": "nombre breve del plato completo en español", "mainItem": {"label": "nombre del componente principal", "sizeOptions": [{"label": "referencia intuitiva ej Media palma", "grams": numero, "calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero}, {"label": "...", "grams": numero, "calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero}, {"label": "...", "grams": numero, "calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero}], "bestGuessIndex": indice_0_1_o_2}, "sides": {"label": "nombre breve de los acompañamientos, o vacío si no hay", "calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero}, "confidence": "alta, media o baja", "note": "una frase corta aclarando el supuesto de porción usado para los acompañamientos", "comment": "un comentario nutricional breve y constructivo sobre esta comida puntual — si tiene mucha grasa, sodio o azúcar, sugerí un cambio concreto (ej: cambiar papas fritas por ensalada); si está bien balanceada, decilo también. Máximo 1 oración corta, tono cercano, nunca alarmista ni culpabilizador"}. '
            + 'Si el plato NO tiene un componente principal ambiguo (ej: es un solo alimento simple y fácil de estimar, como una fruta entera o un producto envasado reconocible), omití "mainItem" y en su lugar devolvé directamente {"calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero} al mismo nivel que "name", igual que antes. Si hay varios alimentos y ninguno es claramente "principal", tratá el más grande como principal. Respondé SOLO el JSON.'
        }
      ]
    }];
  } else if (payload.action === 'texto') {
    if (!payload.foodName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el nombre del alimento' }) };
    const prompt = 'Sos un nutricionista. Para el alimento o plato "' + payload.foodName + '", estimá una porción estándar/típica (si el nombre es ambiguo, asumí la interpretación más común en Argentina) y respondé en JSON puro (sin texto adicional, sin backticks, sin markdown): {"calories": numero_entero, "protein_g": numero, "carbs_g": numero, "fat_g": numero, "confidence": "alta, media o baja"}. Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else if (payload.action === 'actividad') {
    if (!payload.activityName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta la actividad' }) };
    const duration = payload.durationMin ? payload.durationMin + ' minutos' : 'una sesión típica de 30 minutos';
    const weight = payload.weightKg ? payload.weightKg + ' kg' : '75 kg (peso promedio, no especificado)';
    const prompt = 'Sos un fisiólogo del ejercicio. Estimá las calorías quemadas en la actividad "' + payload.activityName + '" durante ' + duration + ', para una persona de ' + weight + '. Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown): {"calories": numero_entero, "confidence": "alta, media o baja"}. Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else if (payload.action === 'sugerencias') {
    const restantes = payload.remainingKcal;
    const comidas = (payload.foodsToday && payload.foodsToday.length) ? payload.foodsToday.join(', ') : 'nada todavía';
    const prompt = 'Sos un nutricionista argentino. A esta persona le quedan aproximadamente ' + restantes + ' kcal para llegar a su meta diaria de ' + payload.targetIntake + ' kcal (ya comió hoy: ' + comidas + '). '
      + (payload.ingredient ? 'Quiere específicamente opciones basadas en: "' + payload.ingredient + '". Las 3 opciones tienen que usar ese ingrediente como base. ' : '')
      + 'Sugerí 3 opciones de comida o colación realistas, variadas, de cocina cotidiana argentina, que se acerquen a esa cantidad de calorías sin pasarse mucho, priorizando buena cantidad de proteína ya que está en déficit calórico. '
      + 'Si el valor de kcal restantes es muy bajo (menos de 150) o negativo, aclarálo en la nota y sugerí opciones livianas o directamente decí que ya cumplió el objetivo del día. '
      + 'Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown): {"note": "frase corta de contexto", "options": [{"name": "nombre del plato", "calories": numero_entero, "protein_g": numero, "reason": "una frase corta de por qué la sugerís"}]}. Devolvé exactamente 3 opciones. Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else if (payload.action === 'rutina') {
    const planText = (payload.plan || []).map(p => p.day + ': ' + p.focus).join(' | ') || 'sin plan (usar full body genérico)';
    const prompt = 'Sos un entrenador de fuerza. El usuario ya decidió su propio split semanal — vos SOLO tenés que completar los ejercicios de cada día, respetando EXACTAMENTE ese plan (mismos días, mismo foco muscular por día, mismo orden). '
      + 'Plan del usuario: ' + planText + '. '
      + 'Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown) con esta forma: '
      + '{"splitName": "nombre corto que resuma el split del usuario", "days": [{"day": "Día 1", "focus": "el mismo foco que te pasé para ese día", "exercises": [{"name": "ejercicio", "sets": numero, "reps": "rango de reps ej 8-10", "note": "tip breve opcional"}]}], "coachNote": "1-2 frases breves con foco de la semana"}. '
      + 'Reglas: 4 a 6 ejercicios por día, TODOS coherentes con el foco muscular de ESE día específico — no mezcles grupos musculares que no correspondan a ese día (ej: si el foco es "Piernas", nada de pecho o espalda ese día). Variedad realista de gimnasio. '
      + 'Los últimos entrenamientos registrados fueron: ' + (payload.recentSummary || 'sin datos') + '. '
      + 'Los splits de semanas anteriores fueron: ' + (payload.previousSplits || 'ninguna') + '; para dar variedad, evitá repetir los mismos ejercicios exactos de esas semanas cuando el foco lo permita. '
      + 'La persona está en un objetivo calórico de ' + (payload.goalPhrase || 'mantenimiento') + ', considerá eso en el coachNote (recuperación, intensidad). '
      + 'Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else if (payload.action === 'nutria') {
    const catLabels = { alimentacion: 'alimentación', gimnasio: 'gimnasio', deporte: 'deporte', general: 'general (todos los datos)' };
    const catLabel = catLabels[payload.category] || 'general';
    const prompt = 'Sos un coach personal de nutrición y entrenamiento, cercano y directo, que le habla de vos a un usuario argentino. '
      + 'Te paso un resumen real de sus datos de ' + catLabel + ': ' + (payload.context || 'sin datos') + '. '
      + (payload.question
        ? 'El usuario pregunta puntualmente: "' + payload.question + '". Respondé eso específicamente, basándote en los datos. '
        : 'Dale un análisis breve de cómo viene, qué está funcionando y qué podría ajustar. ')
      + 'Basate SOLO en los datos que te pasé, no inventes números. Si los datos son escasos o insuficientes para responder bien, decilo con honestidad y sugerí qué cargar para tener un análisis mejor la próxima vez. '
      + 'Máximo 2-3 oraciones cortas, sin relleno, tono cercano de entrenador que conoce a la persona. Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown): {"answer": "tu respuesta"}. Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Acción desconocida' }) };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, messages })
    });
    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Error de la API de Anthropic', detail: errText }) };
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Respuesta sin contenido de texto' }) };
    const clean = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    await incrementUsage(user.id, bucket, usage);
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno', detail: String(err) }) };
  }
};
