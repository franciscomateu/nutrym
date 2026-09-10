// Función serverless: intermediaria entre el front y la API de Anthropic.
// La API key vive solo acá (variable de entorno de Netlify), nunca en el navegador.
// Un token compartido simple (APP_TOKEN) evita que alguien que encuentre la URL
// de esta función te consuma la cuota sin tu conocimiento.

const MODEL = 'claude-sonnet-4-6';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
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
          text: 'Sos un nutricionista. Mirá esta foto de comida y estimá, en JSON puro (sin texto adicional, sin backticks, sin markdown), lo siguiente: {"name": "nombre breve del plato en español", "calories": numero_entero_estimado, "protein_g": numero, "carbs_g": numero, "fat_g": numero, "confidence": "alta, media o baja", "note": "una frase corta aclarando el supuesto de porción usado"}. Si hay varios alimentos en la foto, sumá el total estimado. Respondé SOLO el JSON, nada más.'
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
      + 'Sugerí 3 opciones de comida o colación realistas, variadas, de cocina cotidiana argentina, que se acerquen a esa cantidad de calorías sin pasarse mucho, priorizando buena cantidad de proteína ya que está en déficit calórico. '
      + 'Si el valor de kcal restantes es muy bajo (menos de 150) o negativo, aclarálo en la nota y sugerí opciones livianas o directamente decí que ya cumplió el objetivo del día. '
      + 'Respondé en JSON puro (sin texto adicional, sin backticks, sin markdown): {"note": "frase corta de contexto", "options": [{"name": "nombre del plato", "calories": numero_entero, "protein_g": numero, "reason": "una frase corta de por qué la sugerís"}]}. Devolvé exactamente 3 opciones. Respondé SOLO el JSON.';
    messages = [{ role: 'user', content: prompt }];
  } else if (payload.action === 'rutina') {
    const prompt = 'Sos un entrenador de fuerza. Armá una rutina semanal de gimnasio en JSON puro (sin texto adicional, sin backticks, sin markdown) con esta forma: '
      + '{"splitName": "nombre del tipo de split en español", "days": [{"day": "Lunes", "focus": "grupos musculares del día", "exercises": [{"name": "ejercicio", "sets": numero, "reps": "rango de reps ej 8-10", "note": "tip breve opcional"}]}], "coachNote": "2-3 frases con foco de la semana"}. '
      + 'Reglas: 3 a 5 días de entrenamiento distribuidos en la semana (Lunes a Domingo), 4 a 6 ejercicios por día, variedad realista de gimnasio. '
      + 'Los últimos entrenamientos registrados fueron: ' + (payload.recentSummary || 'sin datos') + '. '
      + 'Los splits de semanas anteriores fueron: ' + (payload.previousSplits || 'ninguna') + '; elegí un enfoque distinto a esos para dar variedad. '
      + 'La persona está en un objetivo calórico de ' + (payload.goalPhrase || 'mantenimiento') + ', considerá eso en el coachNote (recuperación, intensidad). '
      + 'Respondé SOLO el JSON.';
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
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages })
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
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Error interno', detail: String(err) }) };
  }
};
