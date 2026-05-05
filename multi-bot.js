// Control de frecuencia por numero
const controlFrecuencia = new Map();
const LIMITE_HORAS = 1; // puedes poner 24 si quieres solo 1 vez al dia

function puedeEnviar(numero) {
  const ahora = Date.now();
  const ultimaVez = controlFrecuencia.get(numero);

  if (!ultimaVez) {
    controlFrecuencia.set(numero, ahora);
    return true;
  }

  const diferenciaHoras = (ahora - ultimaVez) / (1000 * 60 * 60);

  if (diferenciaHoras >= LIMITE_HORAS) {
    controlFrecuencia.set(numero, ahora);
    return true;
  }

  return false;
}

const process = require('process');
process.setMaxListeners(50);

process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err.message);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err.message);
});

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 3030);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(18).toString('hex');
const AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const clients = new Map();

const mensajeComun = `👋 Hola, somos *Transmillas* 🚛

Ahora puedes solicitar tus envíos, hacer seguimiento y gestionar todo fácilmente desde nuestro *asistente virtual* 🤖.

📲 Escríbenos aquí:
👉 310 809 3773

O solicita tu servicio directamente aquí:
🔵 https://sistema.transmillas.com/nueva_plataforma/controller/SolicitudWhatsAppController.php`;

const botIds = ['empresa-bot-1','empresa-bot-2','empresa-bot-3',
  'empresa-bot-4','empresa-bot-5','empresa-bot-6','empresa-bot-7','empresa-bot-8'];
// const botIds = [
//   'empresa-bot-1','empresa-bot-2','empresa-bot-3','empresa-bot-4',
//   'empresa-bot-5','empresa-bot-6','empresa-bot-7','empresa-bot-8',
//   'empresa-bot-9','empresa-bot-10','empresa-bot-11','empresa-bot-12',
//   'empresa-bot-13','empresa-bot-14','empresa-bot-15'
// ];

const numerosBots = [
  '573176460989@c.us','573166910614@c.us','573102847718@c.us',
  '573002173949@c.us','573202557714@c.us','573176459273@c.us',
  '573165252762@c.us','573176459257@c.us','573104160712@c.us',
  '573176428314@c.us','573176459275@c.us','573176460987@c.us',
  '573125737573@c.us','573108093773@c.us'
];

// Anti-duplicados
const processedMessages = new Map();
const MESSAGE_TTL_MS = 1000 * 30;

function markProcessed(id) {
  processedMessages.set(id, Date.now());
}

function isProcessed(id) {
  return processedMessages.has(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [mid, ts] of processedMessages.entries()) {
    if (now - ts > MESSAGE_TTL_MS) processedMessages.delete(mid);
  }
}, 60000);

function tieneSesionGuardada(id) {
  return fs.existsSync(path.join(AUTH_DIR, `session-${id}`));
}

function crearEstado(id) {
  return {
    id,
    client: null,
    status: 'detenido',
    waState: '',
    numero: '',
    nombre: '',
    qrText: '',
    qrAt: null,
    manualQr: false,
    reconnectTimer: null,
    lastError: '',
    lastReadyAt: null,
    lastCheckAt: null,
    lastDisconnectedAt: null
  };
}

function estadoBot(id) {
  if (!clients.has(id)) clients.set(id, crearEstado(id));
  return clients.get(id);
}

function actualizarInfoVinculada(estado, client) {
  const info = client.info || {};
  const wid = info.wid || info.me || {};
  const numero = wid.user || (wid._serialized ? wid._serialized.replace('@c.us', '') : '');

  if (numero) estado.numero = numero;
  if (info.pushname) estado.nombre = info.pushname;
}

async function verificarEstadoBot(estado) {
  if (!estado.client) return;

  try {
    const waState = await estado.client.getState();
    estado.waState = waState || '';
    estado.lastCheckAt = new Date();
    actualizarInfoVinculada(estado, estado.client);

    if (waState === 'CONNECTED') {
      estado.status = 'listo';
      return;
    }

    if (waState && estado.status === 'listo') {
      estado.status = 'desconectado';
      estado.lastDisconnectedAt = new Date();
    }
  } catch (err) {
    estado.lastError = err.message;
    estado.lastCheckAt = new Date();

    if (estado.status === 'listo' || estado.status === 'autenticado') {
      estado.status = 'desconectado';
      estado.waState = 'CHECK_ERROR';
      estado.lastDisconnectedAt = new Date();
    }
  }
}

async function verificarEstadosBots() {
  for (const id of botIds) {
    await verificarEstadoBot(estadoBot(id));
  }
}

function iniciarMonitorEstados() {
  setInterval(() => {
    verificarEstadosBots().catch(err => {
      console.error('Error verificando estados:', err.message);
    });
  }, 30000);
}

function iniciarBot(id, opciones = {}) {
  const estado = estadoBot(id);

  if (estado.client) {
    if (opciones.manualQr) estado.manualQr = true;
    return estado;
  }

  estado.manualQr = Boolean(opciones.manualQr);
  estado.status = 'iniciando';
  estado.waState = '';
  estado.qrText = '';
  estado.qrAt = null;
  estado.lastError = '';

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  estado.client = client;

  client.on('qr', qr => {
    qrcode.generate(qr, { small: true }, output => {
      estado.qrText = output;
      estado.qrAt = new Date();
      estado.status = 'esperando_qr';
      estado.waState = 'QR';

      if (estado.manualQr) {
        console.log(`\nEscanea QR para conectar ${id}`);
        console.log(output);
      } else {
        console.log(`${id} necesita QR. Generelo desde el panel admin.`);
      }
    });
  });

  client.on('authenticated', () => {
    estado.status = 'autenticado';
    estado.manualQr = false;
    estado.qrText = '';
    estado.qrAt = null;
    console.log(`${id} autenticado`);
  });

  client.on('ready', () => {
    estado.status = 'listo';
    estado.waState = 'CONNECTED';
    estado.manualQr = false;
    estado.lastReadyAt = new Date();
    actualizarInfoVinculada(estado, client);
    console.log(`${id} listo`);
  });

  client.on('auth_failure', msg => {
    estado.status = 'fallo_auth';
    estado.waState = 'AUTH_FAILURE';
    estado.lastError = msg || 'Fallo de autenticacion';
    console.error(`${id} fallo de autenticacion:`, estado.lastError);
  });

  client.on('message', async msg => {
    try {
      if (msg.fromMe) return;
      if (msg.from === 'status@broadcast') return;
      if (numerosBots.includes(msg.from)) return;

      const msgId = msg.id._serialized;
      if (isProcessed(msgId)) return;
      markProcessed(msgId);

      console.log(`(${id}) Mensaje de ${msg.from}: "${msg.body}"`);

      if (puedeEnviar(msg.from)) {
        await client.sendMessage(msg.from, mensajeComun);
        console.log(`(${id}) Mensaje automatico enviado a ${msg.from}`);
      } else {
        console.log(`(${id}) No se envia mensaje repetido a ${msg.from}`);
      }
    } catch (err) {
      console.error(`(${id}) Error manejando mensaje:`, err.message);
    }
  });

  client.on('disconnected', reason => {
    console.log(`${id} desconectado: ${reason}`);
    estado.status = 'desconectado';
    estado.waState = String(reason || 'DISCONNECTED');
    estado.client = null;
    estado.lastDisconnectedAt = new Date();

    if (estado.reconnectTimer) clearTimeout(estado.reconnectTimer);
    estado.reconnectTimer = setTimeout(() => {
      iniciarBot(id, { manualQr: false });
    }, 5000);
  });

  client.initialize().catch(err => {
    estado.status = 'error';
    estado.waState = 'ERROR';
    estado.lastError = err.message;
    estado.client = null;
    console.error(`${id} no pudo iniciar:`, err.message);
  });

  return estado;
}

async function iniciarBotsConSesion() {
  for (const id of botIds) {
    if (tieneSesionGuardada(id)) {
      iniciarBot(id);
      console.log(`Iniciando ${id} con sesion guardada...`);
      await new Promise(r => setTimeout(r, 4000));
    } else {
      console.log(`${id} sin sesion guardada. Use el panel admin para generar QR.`);
    }
  }
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function validarAdmin(reqUrl) {
  return reqUrl.searchParams.get('token') === ADMIN_TOKEN;
}

function responder(res, statusCode, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

function formatearFecha(fecha) {
  return fecha ? fecha.toLocaleString() : 'Nunca';
}

function obtenerEtiquetaVinculo(estado) {
  if (estado.status === 'listo') return { clase: 'ok', texto: 'Vinculado' };
  if (estado.status === 'esperando_qr') return { clase: 'warn', texto: 'Requiere QR' };
  if (estado.status === 'desconectado' || estado.status === 'fallo_auth' || estado.status === 'error') {
    return { clase: 'bad', texto: 'No vinculado' };
  }
  return { clase: 'neutral', texto: 'Revisando' };
}

function renderBotCard(id, token) {
  const estado = estadoBot(id);
  const etiqueta = obtenerEtiquetaVinculo(estado);
  const status = htmlEscape(estado.status);
  const waState = estado.waState ? ` - WhatsApp: <strong>${htmlEscape(estado.waState)}</strong>` : '';
  const sesion = tieneSesionGuardada(id) ? 'Si' : 'No';
  const numero = estado.numero ? `+${estado.numero}` : 'Sin detectar';
  const nombre = estado.nombre || 'Sin nombre';
  const error = estado.lastError ? `<div class="error">${htmlEscape(estado.lastError)}</div>` : '';
  const qr = estado.qrText
    ? `<pre class="qr">${htmlEscape(estado.qrText)}</pre><small>QR generado: ${htmlEscape(estado.qrAt.toLocaleString())} <span class="qr-countdown" data-qr-at="${estado.qrAt.toISOString()}"></span></small>`
    : '<div class="muted">Sin QR activo.</div>';

  return `
      <section class="bot" id="bot-${htmlEscape(id)}" data-bot-id="${htmlEscape(id)}">
        <div class="topline">
          <div>
            <span class="module-label">Cuenta WhatsApp</span>
            <h2>${htmlEscape(id)}</h2>
            <p><span class="badge ${etiqueta.clase}">${etiqueta.texto}</span></p>
          </div>
          <form method="POST" action="/qr/${encodeURIComponent(id)}?token=${token}" data-qr-form data-bot-id="${htmlEscape(id)}">
            <button type="submit">Generar QR</button>
          </form>
        </div>
        <div class="details">
          <p><span>Numero vinculado</span><strong>${htmlEscape(numero)}</strong></p>
          <p><span>Nombre</span><strong>${htmlEscape(nombre)}</strong></p>
          <p><span>Estado interno</span><strong>${status}</strong>${waState}</p>
          <p><span>Sesion guardada</span><strong>${sesion}</strong></p>
          <p><span>Ultimo listo</span><strong>${htmlEscape(formatearFecha(estado.lastReadyAt))}</strong></p>
          <p><span>Ultima revision</span><strong>${htmlEscape(formatearFecha(estado.lastCheckAt))}</strong></p>
          <p><span>Ultima desconexion</span><strong>${htmlEscape(formatearFecha(estado.lastDisconnectedAt))}</strong></p>
          ${error}
        </div>
        ${qr}
      </section>`;
}

function renderSummary() {
  const resumen = botIds.reduce((acc, id) => {
    const etiqueta = obtenerEtiquetaVinculo(estadoBot(id));
    acc[etiqueta.texto] = (acc[etiqueta.texto] || 0) + 1;
    return acc;
  }, {});

  return `
      <strong>Vinculados: ${resumen.Vinculado || 0}</strong>
      <strong>Requieren QR: ${resumen['Requiere QR'] || 0}</strong>
      <strong>No vinculados: ${resumen['No vinculado'] || 0}</strong>`;
}

function renderPanel(reqUrl) {
  const token = htmlEscape(reqUrl.searchParams.get('token') || '');
  const rows = botIds.map(id => renderBotCard(id, token)).join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Panel WhatsApp Bots</title>
  <style>
    :root {
      --azul: #0b3f88;
      --azul-oscuro: #073064;
      --azul-suave: #e8f1ff;
      --verde: #00856f;
      --rojo: #c62828;
      --amarillo: #f2a900;
      --borde: #d8e1ec;
      --fondo: #eef3f8;
      --texto: #17233c;
      --muted: #667085;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; background: var(--fondo); color: var(--texto); }
    header { background: var(--azul); color: white; border-bottom: 4px solid var(--amarillo); }
    .header-inner { max-width: 1220px; margin: 0 auto; padding: 18px 24px; display: flex; justify-content: space-between; gap: 18px; align-items: center; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-mark { width: 42px; height: 42px; border-radius: 6px; background: white; color: var(--azul); display: grid; place-items: center; font-weight: 800; letter-spacing: 0; }
    .brand h1 { margin: 0; font-size: 22px; font-weight: 800; }
    .brand p { margin: 4px 0 0; color: #dce9ff; font-size: 13px; }
    .header-pill { border: 1px solid rgba(255,255,255,0.34); border-radius: 6px; padding: 9px 12px; color: #eef6ff; font-size: 13px; white-space: nowrap; }
    main { max-width: 1220px; margin: 0 auto; padding: 22px 24px 34px; }
    .summary { display: flex; justify-content: space-between; gap: 14px; align-items: center; flex-wrap: wrap; background: white; border: 1px solid var(--borde); border-radius: 6px; margin-bottom: 14px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
    .summary-data { display: flex; gap: 10px; flex-wrap: wrap; }
    .summary-data strong { background: var(--azul-suave); border: 1px solid #cfe0f7; color: var(--azul-oscuro); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    .bot { background: white; border: 1px solid var(--borde); border-left: 5px solid var(--azul); border-radius: 6px; margin-bottom: 12px; padding: 15px 16px; box-shadow: 0 1px 2px rgba(16,24,40,0.04); }
    .bot h2 { margin: 3px 0 8px; font-size: 19px; color: var(--azul-oscuro); }
    .bot p { margin: 0; }
    .module-label { color: var(--muted); display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .topline { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding-bottom: 12px; border-bottom: 1px solid #edf1f6; }
    .details { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 16px; margin: 14px 0; }
    .details p { min-height: 54px; border: 1px solid #edf1f6; border-radius: 6px; background: #fbfcfe; padding: 9px 10px; font-size: 13px; }
    .details span { display: block; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 5px; }
    .details strong { color: #111827; }
    button { background: var(--verde); color: white; border: 0; border-radius: 6px; padding: 10px 14px; cursor: pointer; font-weight: 700; box-shadow: 0 1px 0 rgba(0,0,0,0.08); }
    button:hover { background: #006f5d; }
    button[disabled] { cursor: wait; opacity: 0.7; }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      margin-right: 8px;
      border: 2px solid rgba(255,255,255,0.55);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .qr-countdown { display: inline-block; margin-left: 8px; font-weight: 700; color: #facc15; }
    .qr-countdown.expired { color: #dc2626; }
    .badge { display: inline-block; border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 800; }
    .badge.ok { background: #dcfce7; color: #166534; }
    .badge.warn { background: #fef3c7; color: #92400e; }
    .badge.bad { background: #fee2e2; color: #991b1b; }
    .badge.neutral { background: #e5e7eb; color: #374151; }
    .qr { overflow: auto; background: #0f172a; color: white; padding: 14px; border-radius: 6px; line-height: 1; font-family: Consolas, monospace; font-size: 10px; border: 1px solid #27364f; }
    .muted { color: var(--muted); font-size: 13px; }
    .error { color: var(--rojo); background: #fff5f5; border: 1px solid #ffd7d7; border-radius: 6px; padding: 9px 10px; margin-bottom: 10px; font-size: 13px; }
    small { color: var(--muted); display: block; margin-top: 8px; }
    @media (max-width: 720px) {
      .header-inner, .topline { flex-direction: column; align-items: stretch; }
      .header-pill { white-space: normal; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="brand">
        <div class="brand-mark">TM</div>
        <div>
          <h1>Panel WhatsApp Bots</h1>
          <p>Administracion de vinculaciones y codigos QR</p>
        </div>
      </div>
      <div class="header-pill">Acceso local protegido por token</div>
    </div>
  </header>
  <main>
    <section class="summary">
      <div class="summary-data" id="summary-data">${renderSummary()}</div>
      <form method="POST" action="/check?token=${token}" id="check-form">
        <button type="submit">Revisar estados</button>
      </form>
    </section>
    ${rows}
  </main>
  <script>
    const token = ${JSON.stringify(reqUrl.searchParams.get('token') || '')};

    async function replaceBotCard(id) {
      const response = await fetch('/bot/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(token));
      if (!response.ok) throw new Error('No se pudo actualizar ' + id);
      const html = await response.text();
      const current = document.getElementById('bot-' + id);
      if (current) {
        current.outerHTML = html;
        initQrTimers();
      }
    }

    const QR_TTL_SECONDS = 60;

    function formatDuration(seconds) {
      const minutes = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    function updateQrTimer(element) {
      const qrAt = element.dataset.qrAt ? new Date(element.dataset.qrAt) : null;
      if (!qrAt) return;

      const elapsed = Math.floor((Date.now() - qrAt.getTime()) / 1000);
      const remaining = QR_TTL_SECONDS - elapsed;
      if (remaining > 0) {
        element.textContent = `expira en ${formatDuration(remaining)}`;
        element.classList.remove('expired');
      } else {
        element.textContent = 'QR expirado';
        element.classList.add('expired');
      }
    }

    function initQrTimers() {
      const timerElements = document.querySelectorAll('.qr-countdown');
      if (!timerElements.length) return;
      timerElements.forEach(updateQrTimer);
    }

    setInterval(() => {
      document.querySelectorAll('.qr-countdown').forEach(updateQrTimer);
    }, 1000);

    async function replaceSummary() {
      const response = await fetch('/summary?token=' + encodeURIComponent(token));
      if (!response.ok) return;
      document.getElementById('summary-data').innerHTML = await response.text();
    }

    async function pollBot(id) {
      for (let intento = 0; intento < 12; intento++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await replaceBotCard(id);
        await replaceSummary();
      }
    }

    document.addEventListener('submit', async event => {
      const form = event.target;
      const qrForm = form.closest('[data-qr-form]');

      if (qrForm) {
        event.preventDefault();
        const id = qrForm.dataset.botId;
        const button = qrForm.querySelector('button');
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span>Generando...';

        try {
          await fetch(qrForm.action, { method: 'POST' });
          await replaceBotCard(id);
          await replaceSummary();
          await pollBot(id);
        } catch (err) {
          alert(err.message);
        } finally {
          const updatedButton = document.querySelector('#bot-' + CSS.escape(id) + ' [data-qr-form] button');
          if (updatedButton) {
            updatedButton.disabled = false;
            updatedButton.innerHTML = 'Generar QR';
          }
        }
        return;
      }

      if (form.id === 'check-form') {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        button.textContent = 'Revisando...';

        try {
          await fetch(form.action, { method: 'POST' });
          await Promise.all(${JSON.stringify(botIds)}.map(id => replaceBotCard(id)));
          await replaceSummary();
        } catch (err) {
          alert(err.message);
        } finally {
          button.disabled = false;
          button.textContent = 'Revisar estados';
        }
      }
    });

    initQrTimers();
  </script>
</body>
</html>`;
}

function iniciarPanelAdmin() {
  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);

    if (!validarAdmin(reqUrl)) {
      responder(res, 401, '<h1>401</h1><p>Token invalido.</p>');
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/') {
      responder(res, 200, renderPanel(reqUrl));
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/summary') {
      responder(res, 200, renderSummary());
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname.startsWith('/bot/')) {
      const id = decodeURIComponent(reqUrl.pathname.replace('/bot/', ''));
      if (!botIds.includes(id)) {
        responder(res, 404, '<h1>404</h1><p>Bot no encontrado.</p>');
        return;
      }

      responder(res, 200, renderBotCard(id, htmlEscape(reqUrl.searchParams.get('token') || '')));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/check') {
      await verificarEstadosBots();
      responder(res, 204, '');
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname.startsWith('/qr/')) {
      const id = decodeURIComponent(reqUrl.pathname.replace('/qr/', ''));
      if (!botIds.includes(id)) {
        responder(res, 404, '<h1>404</h1><p>Bot no encontrado.</p>');
        return;
      }

      iniciarBot(id, { manualQr: true });
      responder(res, 204, '');
      return;
    }

    responder(res, 404, '<h1>404</h1>');
  });

  server.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`Panel admin: http://0.0.0.0:${ADMIN_PORT}/?token=${ADMIN_TOKEN}`);
    if (!process.env.ADMIN_TOKEN) {
      console.log('Configure ADMIN_TOKEN para dejar una clave fija de administracion.');
    }
  });
}

iniciarPanelAdmin();
iniciarMonitorEstados();
iniciarBotsConSesion();
