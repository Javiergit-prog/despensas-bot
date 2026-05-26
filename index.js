const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURACIÓN — Reemplaza con tus datos de UltraMsg
// ============================================================
const INSTANCE_ID = process.env.INSTANCE_ID || 'instance177885';
const TOKEN = process.env.TOKEN || 'sqw8v6kyxnu2dlsm';
const ULTRAMSG_URL = `https://api.ultramsg.com/${INSTANCE_ID}/messages/chat`;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '5215576683884@c.us'; // Teléfono del admin con código de país

// ============================================================
// BASE DE DATOS SIMPLE (archivo JSON local)
// ============================================================
const DB_FILE = path.join(__dirname, 'usuarios.json');

function cargarDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ usuarios: [], contador: 0 }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function guardarDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function generarID(contador) {
  return 'DESP-' + String(contador).padStart(6, '0');
}

// ============================================================
// ESTADO DE CONVERSACIÓN (en memoria)
// ============================================================
const sesiones = {}; // { telefono: { paso, datos } }

// ============================================================
// ENVIAR MENSAJE WHATSAPP
// ============================================================
async function enviarMensaje(telefono, mensaje) {
  try {
    await axios.post(ULTRAMSG_URL, {
      token: TOKEN,
      to: telefono,
      body: mensaje
    });
  } catch (err) {
    console.error('Error enviando mensaje:', err.message);
  }
}

// ============================================================
// MENÚ PRINCIPAL
// ============================================================
function menuPrincipal() {
  return `🌽 *BIENVENIDO A DESPENSAS*

¿Qué deseas hacer?

1️⃣ Registrarme como nuevo usuario
2️⃣ Ver mi información y mi ID
3️⃣ Invitar a mis referidos
4️⃣ Registrar mi pago
5️⃣ Reportar un problema

Responde con el *número* de tu opción.`;
}

// ============================================================
// LÓGICA PRINCIPAL DEL BOT
// ============================================================
async function procesarMensaje(telefono, mensaje) {
  const db = cargarDB();
  const texto = mensaje.trim();
  const sesion = sesiones[telefono] || { paso: 'menu' };

  // Buscar si ya existe el usuario
  const usuarioExistente = db.usuarios.find(u => u.telefono === telefono);

  // ── OPCIÓN 1: REGISTRO NUEVO ──────────────────────────────
  if (sesion.paso === 'menu' && texto === '1') {
    if (usuarioExistente) {
      await enviarMensaje(telefono,
        `⚠️ Ya tienes una cuenta registrada.\n\n` +
        `Tu ID es: *${usuarioExistente.id}*\n\n` +
        `Escribe *MENU* para ver las opciones.`
      );
      return;
    }
    sesiones[telefono] = { paso: 'pedir_nombre', datos: {} };
    await enviarMensaje(telefono,
      `✏️ *REGISTRO DE NUEVO USUARIO*\n\n` +
      `¿Cuál es tu nombre completo?`
    );
    return;
  }

  if (sesion.paso === 'pedir_nombre') {
    sesiones[telefono] = { paso: 'pedir_referido', datos: { nombre: texto } };
    await enviarMensaje(telefono,
      `👍 Gracias *${texto}*.\n\n` +
      `¿Tienes un código de quien te invitó?\n` +
      `(Ejemplo: DESP-000001)\n\n` +
      `Si no tienes código, escribe *NO*`
    );
    return;
  }

  if (sesion.paso === 'pedir_referido') {
    const codigoReferido = texto.toUpperCase();
    let referidoPor = null;

    if (codigoReferido !== 'NO') {
      const referidor = db.usuarios.find(u => u.id === codigoReferido);
      if (!referidor) {
        await enviarMensaje(telefono,
          `❌ No encontré ese código. Verifica e intenta de nuevo.\n\n` +
          `O escribe *NO* si no tienes código de referido.`
        );
        return;
      }
      referidoPor = codigoReferido;
    }

    // Crear el nuevo usuario
    db.contador += 1;
    const nuevoID = generarID(db.contador);
    const nuevoUsuario = {
      id: nuevoID,
      nombre: sesion.datos.nombre,
      telefono: telefono,
      referidoPor: referidoPor,
      referidos: [],
      fechaRegistro: new Date().toISOString(),
      pagos: [],
      consumos: [],
      activo: true
    };

    // Actualizar referidos del que invitó
    if (referidoPor) {
      const idx = db.usuarios.findIndex(u => u.id === referidoPor);
      if (idx !== -1) {
        db.usuarios[idx].referidos.push(nuevoID);
        // Notificar al referidor
        await enviarMensaje(db.usuarios[idx].telefono,
          `🎉 ¡Tienes un nuevo referido!\n` +
          `*${nuevoUsuario.nombre}* se registró con tu código.\n` +
          `Ya tienes *${db.usuarios[idx].referidos.length}* de 4 referidos.`
        );
      }
    }

    db.usuarios.push(nuevoUsuario);
    guardarDB(db);
    delete sesiones[telefono];

    // Mensaje de confirmación al nuevo usuario
    await enviarMensaje(telefono,
      `✅ *¡REGISTRO EXITOSO!*\n\n` +
      `Bienvenido *${nuevoUsuario.nombre}*\n\n` +
      `🪪 Tu ID único es:\n*${nuevoID}*\n\n` +
      `Guarda este ID, lo necesitarás siempre.`
    );

    await new Promise(r => setTimeout(r, 1500));

    await enviarMensaje(telefono,
      `📋 *SIGUIENTE PASO IMPORTANTE*\n\n` +
      `Preséntate con el administrador para recoger tu *credencial física* con tu código de usuario.\n\n` +
      `Sin ella no podrás recoger tu despensa mensual. 🌽`
    );

    // Notificar al admin
    await enviarMensaje(ADMIN_PHONE,
      `🆕 *NUEVO USUARIO REGISTRADO*\n\n` +
      `Nombre: ${nuevoUsuario.nombre}\n` +
      `ID: ${nuevoID}\n` +
      `Teléfono: ${telefono}\n` +
      `Referido por: ${referidoPor || 'Ninguno'}\n` +
      `Fecha: ${new Date().toLocaleDateString('es-MX')}`
    );
    return;
  }

  // ── OPCIÓN 2: VER MI INFORMACIÓN ─────────────────────────
  if (sesion.paso === 'menu' && texto === '2') {
    if (!usuarioExistente) {
      await enviarMensaje(telefono,
        `❌ No tienes cuenta registrada.\n\nEscribe *MENU* y elige la opción 1 para registrarte.`
      );
      return;
    }
    const u = usuarioExistente;
    await enviarMensaje(telefono,
      `👤 *TU INFORMACIÓN*\n\n` +
      `🪪 ID: *${u.id}*\n` +
      `👤 Nombre: ${u.nombre}\n` +
      `👥 Referidos: ${u.referidos.length}/4\n` +
      `📅 Registro: ${new Date(u.fechaRegistro).toLocaleDateString('es-MX')}\n` +
      `✅ Estado: ${u.activo ? 'Activo' : 'Inactivo'}\n\n` +
      `Escribe *MENU* para volver al menú.`
    );
    return;
  }

  // ── OPCIÓN 3: INVITAR REFERIDOS ───────────────────────────
  if (sesion.paso === 'menu' && texto === '3') {
    if (!usuarioExistente) {
      await enviarMensaje(telefono,
        `❌ Necesitas estar registrado primero.\n\nEscribe *MENU* para ver opciones.`
      );
      return;
    }
    const u = usuarioExistente;
    const restantes = 4 - u.referidos.length;
    await enviarMensaje(telefono,
      `👥 *INVITAR REFERIDOS*\n\n` +
      `Tu código para invitar es:\n*${u.id}*\n\n` +
      `Comparte este mensaje con quien quieras invitar:\n\n` +
      `———————————————\n` +
      `🌽 Te invito a unirte a la red de despensas.\n` +
      `Escribe *HOLA* al número del negocio y cuando te pida código de referido pon:\n` +
      `*${u.id}*\n` +
      `———————————————\n\n` +
      `Tienes *${u.referidos.length}/4* referidos registrados.\n` +
      `Te faltan *${restantes}* lugares.`
    );
    return;
  }

  // ── OPCIÓN 4: REGISTRAR PAGO ──────────────────────────────
  if (sesion.paso === 'menu' && texto === '4') {
    if (!usuarioExistente) {
      await enviarMensaje(telefono,
        `❌ No tienes cuenta. Escribe *MENU* para registrarte.`
      );
      return;
    }
    sesiones[telefono] = { paso: 'pedir_monto_pago', datos: {} };
    await enviarMensaje(telefono,
      `💰 *REGISTRAR PAGO*\n\n` +
      `¿Cuánto vas a pagar? (solo el número, ejemplo: 200)`
    );
    return;
  }

  if (sesion.paso === 'pedir_monto_pago') {
    const monto = parseFloat(texto);
    if (isNaN(monto) || monto <= 0) {
      await enviarMensaje(telefono, `❌ Escribe solo el número. Ejemplo: 200`);
      return;
    }
    const idx = db.usuarios.findIndex(u => u.telefono === telefono);
    db.usuarios[idx].pagos.push({
      monto: monto,
      fecha: new Date().toISOString(),
      estado: 'pendiente_confirmacion'
    });
    guardarDB(db);
    delete sesiones[telefono];

    await enviarMensaje(telefono,
      `✅ *PAGO REGISTRADO*\n\n` +
      `Monto: $${monto}\n` +
      `Estado: Pendiente de confirmación\n\n` +
      `El administrador confirmará tu pago en breve.`
    );

    await enviarMensaje(ADMIN_PHONE,
      `💰 *PAGO PENDIENTE DE CONFIRMAR*\n\n` +
      `Usuario: ${usuarioExistente.nombre}\n` +
      `ID: ${usuarioExistente.id}\n` +
      `Monto: $${monto}\n` +
      `Fecha: ${new Date().toLocaleDateString('es-MX')}\n\n` +
      `Para confirmar escribe:\n*CONFIRMAR ${usuarioExistente.id}*`
    );
    return;
  }

  // ── OPCIÓN 5: REPORTAR PROBLEMA ───────────────────────────
  if (sesion.paso === 'menu' && texto === '5') {
    sesiones[telefono] = { paso: 'pedir_reporte', datos: {} };
    await enviarMensaje(telefono,
      `📝 *REPORTAR PROBLEMA*\n\nDescribe tu problema y te contactaremos pronto:`
    );
    return;
  }

  if (sesion.paso === 'pedir_reporte') {
    delete sesiones[telefono];
    await enviarMensaje(telefono,
      `✅ Tu reporte fue enviado al administrador.\nTe contactaremos pronto.`
    );
    await enviarMensaje(ADMIN_PHONE,
      `⚠️ *REPORTE DE USUARIO*\n\n` +
      `De: ${usuarioExistente ? usuarioExistente.nombre : telefono}\n` +
      `ID: ${usuarioExistente ? usuarioExistente.id : 'No registrado'}\n` +
      `Mensaje: ${texto}`
    );
    return;
  }

  // ── COMANDOS DE ADMINISTRADOR ─────────────────────────────
  if (telefono === ADMIN_PHONE) {

    // CONFIRMAR PAGO
    if (texto.startsWith('CONFIRMAR ')) {
      const idUsuario = texto.split(' ')[1];
      const idx = db.usuarios.findIndex(u => u.id === idUsuario);
      if (idx === -1) {
        await enviarMensaje(telefono, `❌ No encontré el usuario ${idUsuario}`);
        return;
      }
      const pagos = db.usuarios[idx].pagos;
      const pagoIdx = pagos.findLastIndex(p => p.estado === 'pendiente_confirmacion');
      if (pagoIdx === -1) {
        await enviarMensaje(telefono, `❌ No hay pagos pendientes para ${idUsuario}`);
        return;
      }
      db.usuarios[idx].pagos[pagoIdx].estado = 'confirmado';
      guardarDB(db);
      await enviarMensaje(telefono, `✅ Pago de ${db.usuarios[idx].nombre} confirmado.`);
      await enviarMensaje(db.usuarios[idx].telefono,
        `✅ *TU PAGO FUE CONFIRMADO*\n\n` +
        `Monto: $${pagos[pagoIdx].monto}\n` +
        `¡Gracias ${db.usuarios[idx].nombre}! 🌽`
      );
      return;
    }

    // REGISTRAR CONSUMO
    if (texto.startsWith('CONSUMO ')) {
      const idUsuario = texto.split(' ')[1];
      const idx = db.usuarios.findIndex(u => u.id === idUsuario);
      if (idx === -1) {
        await enviarMensaje(telefono, `❌ No encontré el usuario ${idUsuario}`);
        return;
      }
      db.usuarios[idx].consumos.push({
        fecha: new Date().toISOString(),
        descripcion: 'Despensa mensual'
      });
      guardarDB(db);
      await enviarMensaje(telefono,
        `✅ Consumo registrado para ${db.usuarios[idx].nombre} (${idUsuario})`
      );
      await enviarMensaje(db.usuarios[idx].telefono,
        `📦 *DESPENSA REGISTRADA*\n\n` +
        `Hola ${db.usuarios[idx].nombre}, tu despensa de este mes fue registrada.\n` +
        `Fecha: ${new Date().toLocaleDateString('es-MX')} 🌽`
      );
      return;
    }

    // REPORTE GENERAL
    if (texto === 'REPORTE') {
      const total = db.usuarios.length;
      const activos = db.usuarios.filter(u => u.activo).length;
      const conPago = db.usuarios.filter(u =>
        u.pagos.some(p => p.estado === 'confirmado')
      ).length;
      await enviarMensaje(telefono,
        `📊 *REPORTE GENERAL*\n\n` +
        `👥 Total usuarios: ${total}\n` +
        `✅ Activos: ${activos}\n` +
        `💰 Con pago confirmado: ${conPago}\n` +
        `⏳ Sin pago: ${total - conPago}\n\n` +
        `Fecha: ${new Date().toLocaleDateString('es-MX')}`
      );
      return;
    }

    // LISTA DE USUARIOS
    if (texto === 'LISTA') {
      if (db.usuarios.length === 0) {
        await enviarMensaje(telefono, `📋 No hay usuarios registrados aún.`);
        return;
      }
      const lista = db.usuarios.slice(-10).map(u =>
        `• ${u.id} — ${u.nombre} — ${u.referidos.length}/4 refs`
      ).join('\n');
      await enviarMensaje(telefono,
        `📋 *ÚLTIMOS 10 USUARIOS*\n\n${lista}\n\nTotal: ${db.usuarios.length} usuarios`
      );
      return;
    }
  }

  // ── MENSAJE DE BIENVENIDA / MENÚ POR DEFECTO ──────────────
  delete sesiones[telefono];
  await enviarMensaje(telefono, menuPrincipal());
}

// ============================================================
// WEBHOOK — UltraMsg envía los mensajes aquí
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a UltraMsg

  const data = req.body;
  if (!data || !data.data) return;

  const msg = data.data;

  // Ignorar mensajes del propio bot o mensajes de grupo
  if (msg.fromMe) return;
  if (msg.from && msg.from.includes('@g.us')) return;
  if (!msg.body) return;

  const telefono = msg.from;
  const mensaje = msg.body;

  console.log(`📩 Mensaje de ${telefono}: ${mensaje}`);
  await procesarMensaje(telefono, mensaje);
});

// Ruta de verificación
app.get('/', (req, res) => {
  res.send('🌽 Bot de Despensas funcionando correctamente.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
