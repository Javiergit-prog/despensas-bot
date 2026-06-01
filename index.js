const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURACION
// ============================================================
const WASENDER_TOKEN = process.env.WASENDER_TOKEN || '3b7473e48f999ed47678f31fb456aa20550a8bbf344e621d80481755dc0a2bc6';
const WASENDER_URL = 'https://api.wasenderapi.com/api/send-message';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '525576683884';

const COLORES_NIVEL = {
  0: 'VIOLETA', 1: 'DORADO', 2: 'AZUL',
  3: 'NARANJA', 4: 'ROSA', 5: 'VERDE',
  6: 'AMARILLO', 7: 'TURQUESA', 8: 'VERDE BANDERA', 9: 'GRIS'
};

// ============================================================
// BASE DE DATOS
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
// SESIONES EN MEMORIA
// ============================================================
const sesiones = {};

// ============================================================
// ENVIAR MENSAJE DE TEXTO
// ============================================================
async function enviarMensaje(telefono, mensaje) {
  try {
    const tel = String(telefono).replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post(WASENDER_URL, {
      to: tel,
      text: mensaje
    }, {
      headers: {
        'Authorization': 'Bearer ' + WASENDER_TOKEN,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Error enviando mensaje:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ============================================================
// ENVIAR IMAGEN (QR)
// ============================================================
async function enviarImagen(telefono, urlImagen, caption) {
  try {
    const tel = String(telefono).replace('@s.whatsapp.net', '').replace('@c.us', '');
    await axios.post('https://api.wasenderapi.com/api/send-image', {
      to: tel,
      image: urlImagen,
      caption: caption
    }, {
      headers: {
        'Authorization': 'Bearer ' + WASENDER_TOKEN,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Error enviando imagen:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

// ============================================================
// ENVIAR CREDENCIAL DIGITAL
// ============================================================
async function enviarCredencial(telefono, usuario) {
  try {
    const nivel = usuario.nivel || 0;
    const color = COLORES_NIVEL[nivel] || 'VIOLETA';
    const fechaVigencia = new Date(usuario.fechaRegistro);
    fechaVigencia.setFullYear(fechaVigencia.getFullYear() + 1);
    const vigencia = fechaVigencia.toLocaleDateString('es-MX', { year: 'numeric', month: 'long' }).toUpperCase();
    const fechaReg = new Date(usuario.fechaRegistro).toLocaleDateString('es-MX');

    await enviarMensaje(telefono,
      '🪪 ━━━━━━━━━━━━━━━━━━━━\n' +
      '   *CREDENCIAL DIGITAL*\n' +
      '━━━━━━━━━━━━━━━━━━━━\n\n' +
      '🛒 *DespensaClub Familiar*\n' +
      '   Red de Consumo Inteligente\n\n' +
      '👤 *' + usuario.nombre.toUpperCase() + '*\n\n' +
      '🪪 ID: *' + usuario.id + '*\n' +
      '🎨 Nivel: *' + nivel + ' — ' + color + '*\n' +
      '📅 Registro: ' + fechaReg + '\n' +
      '⏳ Vigencia: ' + vigencia + '\n\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '_Guarda este mensaje, es tu identificacion oficial._'
    );

    await new Promise(r => setTimeout(r, 1500));

    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(usuario.id);
    await enviarMensaje(telefono, 'Codigo QR de tu credencial ' + usuario.id + ':\n\n' + qrUrl + '\n\nAbre el enlace y guarda la imagen del QR.');

    console.log('Credencial enviada a', telefono);
  } catch (err) {
    console.error('Error enviando credencial:', err.message);
  }
}

// ============================================================
// MENU PRINCIPAL
// ============================================================
function menuPrincipal() {
  return '🛒 *BIENVENIDO A DESPENSACLUB FAMILIAR*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '🥫🧃🍚 *Despensas familiares mensuales*\n' +
    '━━━━━━━━━━━━━━━━━━━━\n\n' +
    'Que deseas hacer?\n\n' +
    '1️⃣ Registrarme como nuevo usuario\n' +
    '2️⃣ Ver mi informacion y mi ID\n' +
    '3️⃣ Invitar a mis referidos\n' +
    '4️⃣ Registrar mi pago\n' +
    '5️⃣ Reportar un problema\n\n' +
    '📲 Responde con el *numero* de tu opcion.';
}

// ============================================================
// LOGICA DEL BOT
// ============================================================
async function procesarMensaje(telefono, mensaje) {
  try {
    const db = cargarDB();
    const texto = mensaje.trim();
    const sesion = sesiones[telefono] || { paso: 'menu' };
    const usuarioExistente = db.usuarios.find(function(u) { return u.telefono === telefono; });
    const telLimpio = String(telefono).replace('@s.whatsapp.net', '').replace('@c.us', '');

    // ── COMANDO ADMIN RAPIDO (funciona desde cualquier paso)
    if (texto === 'RESETBD' && String(telefono).includes('5576683884')) {
      guardarDB({ usuarios: [], contador: 0 });
      Object.keys(sesiones).forEach(k => delete sesiones[k]);
      await enviarMensaje(telefono, 'Base de datos limpiada correctamente. Todos los usuarios de prueba eliminados.');
      return;
    }

    if (texto === 'REPORTE' && String(telefono).includes('5576683884')) {
      const db2 = cargarDB();
      const total = db2.usuarios.length;
      const activos = db2.usuarios.filter(function(u) { return u.activo; }).length;
      const conPago = db2.usuarios.filter(function(u) { return u.pagos.some(function(p) { return p.estado === 'confirmado'; }); }).length;
      await enviarMensaje(telefono, 'REPORTE GENERAL\n\nTotal: ' + total + '\nActivos: ' + activos + '\nCon pago: ' + conPago + '\nSin pago: ' + (total - conPago));
      return;
    }

    if (texto === 'LISTA' && String(telefono).includes('5576683884')) {
      const db2 = cargarDB();
      if (db2.usuarios.length === 0) { await enviarMensaje(telefono, 'No hay usuarios.'); return; }
      const lista = db2.usuarios.slice(-10).map(function(u) {
        return (u.activo ? 'OK' : 'XX') + ' ' + u.id + ' ' + u.nombre + ' Nv.' + (u.nivel||0);
      }).join('\n');
      await enviarMensaje(telefono, 'ULTIMOS 10 USUARIOS\n\n' + lista + '\n\nTotal: ' + db2.usuarios.length);
      return;
    }

    // ── REGISTRO PASO 1
    if (sesion.paso === 'menu' && texto === '1') {
      if (usuarioExistente) {
        await enviarMensaje(telefono, 'Ya tienes una cuenta registrada.\n\nTu ID es: *' + usuarioExistente.id + '*\n\nEscribe MENU para ver las opciones.');
        return;
      }
      sesiones[telefono] = { paso: 'pedir_nombre', datos: {} };
      await enviarMensaje(telefono, '✏️ *REGISTRO DE NUEVO USUARIO*\n\n¿Cual es tu nombre completo?\n\n📋 Por favor escribelo *tal como aparece en tu identificacion INE*');
      return;
    }

    // ── REGISTRO PASO 2 - NOMBRE
    if (sesion.paso === 'pedir_nombre') {
      sesiones[telefono] = { paso: 'pedir_referido', datos: { nombre: texto } };
      await enviarMensaje(telefono, '👍 Gracias *' + texto + '*.\n\n¿Tienes un codigo de quien te invito?\n(Ejemplo: DESP-000001)\n\nSi no tienes codigo escribe *NO*');
      return;
    }

    // ── REGISTRO PASO 3 - REFERIDO
    if (sesion.paso === 'pedir_referido') {
      const codigoReferido = texto.toUpperCase();
      let referidoPor = null;

      if (codigoReferido !== 'NO') {
        const referidor = db.usuarios.find(function(u) { return u.id === codigoReferido; });
        if (!referidor) {
          await enviarMensaje(telefono, '❌ No encontre ese codigo. Verifica e intenta de nuevo.\n\nO escribe *NO* si no tienes codigo.');
          return;
        }
        referidoPor = codigoReferido;
      }

      // Calcular nivel
      let nivelUsuario = 0;
      if (referidoPor) {
        const referidor = db.usuarios.find(function(u) { return u.id === referidoPor; });
        nivelUsuario = referidor ? (referidor.nivel || 0) + 1 : 1;
      }

      db.contador += 1;
      const nuevoID = generarID(db.contador);
      const nuevoUsuario = {
        id: nuevoID,
        nombre: sesion.datos.nombre,
        telefono: telefono,
        telefonoLimpio: telLimpio,
        referidoPor: referidoPor,
        nivel: nivelUsuario,
        referidos: [],
        fechaRegistro: new Date().toISOString(),
        pagos: [],
        consumos: [],
        activo: true
      };

      // Actualizar referidos del invitador
      if (referidoPor) {
        const idx = db.usuarios.findIndex(function(u) { return u.id === referidoPor; });
        if (idx !== -1) {
          db.usuarios[idx].referidos.push(nuevoID);
          await enviarMensaje(db.usuarios[idx].telefono,
            '🎉 Tienes un nuevo referido!\n*' + nuevoUsuario.nombre + '* se registro con tu codigo.\nYa tienes *' + db.usuarios[idx].referidos.length + '* de 4 referidos.'
          );
        }
      }

      db.usuarios.push(nuevoUsuario);
      guardarDB(db);
      delete sesiones[telefono];

      // Mensaje de confirmacion al usuario
      await enviarMensaje(telefono,
        '✅ *REGISTRO EXITOSO!*\n\nBienvenido *' + nuevoUsuario.nombre + '*\n\n🪪 Tu ID unico es:\n*' + nuevoID + '*\n\nGuarda este ID, lo necesitaras siempre.'
      );

      await new Promise(r => setTimeout(r, 1500));

      await enviarMensaje(telefono,
        '📋 *SIGUIENTE PASO IMPORTANTE*\n\nPrestate con el administrador para recoger tu *credencial fisica* con tu codigo de usuario.\n\nSin ella no podras recoger tu despensa mensual. 🎁'
      );

      // Notificar al admin
      const colorNivel = COLORES_NIVEL[nivelUsuario] || 'VIOLETA';
      const referidoTexto = referidoPor ? referidoPor : 'Ninguno';
      const fechaHoy = new Date().toLocaleDateString('es-MX');

      await enviarMensaje(ADMIN_PHONE,
        '🆕 *NUEVO USUARIO REGISTRADO*\n\n' +
        '👤 Nombre: ' + nuevoUsuario.nombre + '\n' +
        '🪪 ID: ' + nuevoID + '\n' +
        '📱 Telefono: +' + telLimpio + '\n' +
        '🎨 Nivel: ' + nivelUsuario + ' — ' + colorNivel + '\n' +
        '👥 Referido por: ' + referidoTexto + '\n' +
        '📅 Fecha: ' + fechaHoy
      );

      // Enviar credencial digital al usuario
      await new Promise(r => setTimeout(r, 2000));
      await enviarCredencial(telefono, nuevoUsuario);

      // Enviar credencial al admin
      await new Promise(r => setTimeout(r, 2000));
      await enviarCredencial(ADMIN_PHONE, nuevoUsuario);

      return;
    }

    // ── OPCION 2: VER INFO
    if (sesion.paso === 'menu' && texto === '2') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta registrada.\n\nEscribe MENU para registrarte.');
        return;
      }
      const u = usuarioExistente;
      const color = COLORES_NIVEL[u.nivel || 0] || 'VIOLETA';
      await enviarMensaje(telefono,
        '👤 *TU INFORMACION*\n\n' +
        '🪪 ID: *' + u.id + '*\n' +
        '👤 Nombre: ' + u.nombre + '\n' +
        '🎨 Nivel: ' + (u.nivel || 0) + ' — ' + color + '\n' +
        '👥 Referidos: ' + u.referidos.length + '/4\n' +
        '📅 Registro: ' + new Date(u.fechaRegistro).toLocaleDateString('es-MX') + '\n' +
        '✅ Estado: ' + (u.activo ? 'Activo' : 'Inactivo') + '\n\n' +
        'Escribe MENU para volver.'
      );
      return;
    }

    // ── OPCION 3: INVITAR
    if (sesion.paso === 'menu' && texto === '3') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ Necesitas estar registrado. Escribe MENU.');
        return;
      }
      const u = usuarioExistente;
      const restantes = 4 - u.referidos.length;
      await enviarMensaje(telefono,
        '👥 *INVITAR REFERIDOS*\n\n' +
        'Tu codigo para invitar es: *' + u.id + '*\n' +
        'Tienes *' + u.referidos.length + '/4* referidos. Te faltan *' + restantes + '*.\n\n' +
        'Copia y comparte este mensaje:\n\n' +
        '——————————————\n' +
        '🛒 *DESPENSACLUB*\n' +
        '_Comunidad de Consumo Inteligente_\n\n' +
        'Hola! Te invito a formar parte de nuestra comunidad de despensas mensuales.\n\n' +
        '*¿Que es DespensaClub?*\n' +
        'Una comunidad donde puedes adquirir productos de despensa mensualmente a un precio accesible y justo.\n\n' +
        '*¿Como funciona?*\n' +
        '1️⃣ Paga tu credencial y membresia — pago unico anual de solo *$50 pesos*\n' +
        '2️⃣ Cada mes recoge tu despensa familiar por *$250 pesos*\n' +
        '3️⃣ Al invitar a familiares, amigos y conocidos que tambien consuman, puedes acumular *bonos y descuentos* en tu membresia\n\n' +
        '*¿Te gustaria registrarte y hacer tus compras de manera inteligente?*\n\n' +
        '👇 Toca el enlace — el mensaje se escribe automaticamente, solo sigue los sencillos pasos:\n' +
        'https://wa.me/525576683884?text=HOLA\n\n' +
        '_Cuando te pidan codigo de referido escribe:_\n' +
        '*' + u.id + '*\n' +
        '——————————————'
      );
      return;
    }

    // ── OPCION 4: PAGO
    if (sesion.paso === 'menu' && texto === '4') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta. Escribe MENU.');
        return;
      }
      sesiones[telefono] = { paso: 'pedir_monto_pago', datos: {} };
      await enviarMensaje(telefono,
        '💰 *REGISTRAR PAGO*\n\n' +
        '¿Cuanto vas a pagar? (solo el numero, ejemplo: *250*)\n\n' +
        '📎 *IMPORTANTE:*\n' +
        '1️⃣ Adjunta el *comprobante de tu pago* en este chat\n' +
        '2️⃣ En la referencia de tu transferencia no olvides colocar tu *numero de ID* (ejemplo: DESP-000001)'
      );
      return;
    }

    if (sesion.paso === 'pedir_monto_pago') {
      const monto = parseFloat(texto);
      if (isNaN(monto) || monto <= 0) {
        await enviarMensaje(telefono, '❌ Escribe solo el numero. Ejemplo: 250');
        return;
      }
      const idx = db.usuarios.findIndex(function(u) { return u.telefono === telefono; });
      db.usuarios[idx].pagos.push({ monto: monto, fecha: new Date().toISOString(), estado: 'pendiente_confirmacion' });
      guardarDB(db);
      delete sesiones[telefono];

      await enviarMensaje(telefono, '✅ *PAGO REGISTRADO*\n\nMonto: $' + monto + '\nEstado: Pendiente de confirmacion\n\nEl administrador confirmara tu pago en breve.');
      await enviarMensaje(ADMIN_PHONE,
        '💰 *PAGO PENDIENTE*\n\n' +
        'Usuario: ' + usuarioExistente.nombre + '\n' +
        'ID: ' + usuarioExistente.id + '\n' +
        'Telefono: +' + telLimpio + '\n' +
        'Monto: $' + monto + '\n' +
        'Fecha: ' + new Date().toLocaleDateString('es-MX') + '\n\n' +
        'Para confirmar escribe:\n*CONFIRMAR ' + usuarioExistente.id + '*'
      );
      return;
    }

    // ── OPCION 5: REPORTE
    if (sesion.paso === 'menu' && texto === '5') {
      sesiones[telefono] = { paso: 'pedir_reporte', datos: {} };
      await enviarMensaje(telefono, '📝 *REPORTAR PROBLEMA*\n\nDescribe tu problema:');
      return;
    }

    if (sesion.paso === 'pedir_reporte') {
      delete sesiones[telefono];
      await enviarMensaje(telefono, '✅ Tu reporte fue enviado. Te contactaremos pronto.');
      await enviarMensaje(ADMIN_PHONE,
        '⚠️ *REPORTE DE USUARIO*\n\n' +
        'De: ' + (usuarioExistente ? usuarioExistente.nombre : telLimpio) + '\n' +
        'ID: ' + (usuarioExistente ? usuarioExistente.id : 'No registrado') + '\n' +
        'Mensaje: ' + texto
      );
      return;
    }

    // ── COMANDOS ADMIN
    const esAdmin = (
      String(telefono).includes('5576683884') ||
      String(telLimpio).includes('5576683884') ||
      telefono === ADMIN_PHONE
    );

    if (esAdmin) {

      if (texto === 'RESETBD') {
        guardarDB({ usuarios: [], contador: 0 });
        await enviarMensaje(telefono, '✅ Base de datos limpiada correctamente.');
        return;
      }

      if (texto.startsWith('CONFIRMAR ')) {
        const idU = texto.split(' ')[1];
        const idx = db.usuarios.findIndex(function(u) { return u.id === idU; });
        if (idx === -1) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        const pagoIdx = db.usuarios[idx].pagos.findLastIndex(function(p) { return p.estado === 'pendiente_confirmacion'; });
        if (pagoIdx === -1) { await enviarMensaje(telefono, '❌ No hay pagos pendientes para ' + idU); return; }
        db.usuarios[idx].pagos[pagoIdx].estado = 'confirmado';
        guardarDB(db);
        await enviarMensaje(telefono, '✅ Pago de ' + db.usuarios[idx].nombre + ' confirmado.');
        await enviarMensaje(db.usuarios[idx].telefono, '✅ *TU PAGO FUE CONFIRMADO*\n\nMonto: $' + db.usuarios[idx].pagos[pagoIdx].monto + '\nGracias ' + db.usuarios[idx].nombre + '! 🎁');
        return;
      }

      if (texto.startsWith('CONSUMO ')) {
        const idU = texto.split(' ')[1];
        const idx = db.usuarios.findIndex(function(u) { return u.id === idU; });
        if (idx === -1) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        db.usuarios[idx].consumos.push({ fecha: new Date().toISOString(), descripcion: 'Despensa mensual' });
        guardarDB(db);
        await enviarMensaje(telefono, '✅ Consumo registrado para ' + db.usuarios[idx].nombre + ' (' + idU + ')');
        await enviarMensaje(db.usuarios[idx].telefono, '📦 *DESPENSA REGISTRADA*\n\nHola ' + db.usuarios[idx].nombre + ', tu despensa fue registrada.\nFecha: ' + new Date().toLocaleDateString('es-MX') + ' 🎁');
        return;
      }

      if (texto.startsWith('DESACTIVAR ')) {
        const idU = texto.split(' ')[1];
        const idx = db.usuarios.findIndex(function(u) { return u.id === idU; });
        if (idx === -1) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        db.usuarios[idx].activo = false;
        const congelados = db.usuarios.filter(function(u) { return u.referidoPor === idU; });
        congelados.forEach(function(r) {
          const ridx = db.usuarios.findIndex(function(u) { return u.id === r.id; });
          db.usuarios[ridx].congelado = true;
        });
        guardarDB(db);
        await enviarMensaje(telefono, '✅ Usuario ' + db.usuarios[idx].nombre + ' desactivado.\nReferidos congelados: ' + congelados.length);
        await enviarMensaje(db.usuarios[idx].telefono, '⚠️ Tu cuenta ha sido suspendida.\nContacta al administrador.');
        return;
      }

      if (texto.startsWith('ACTIVAR ')) {
        const idU = texto.split(' ')[1];
        const idx = db.usuarios.findIndex(function(u) { return u.id === idU; });
        if (idx === -1) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        db.usuarios[idx].activo = true;
        guardarDB(db);
        await enviarMensaje(telefono, '✅ Usuario ' + db.usuarios[idx].nombre + ' reactivado.');
        await enviarMensaje(db.usuarios[idx].telefono, '✅ Tu cuenta ha sido reactivada. Bienvenido de nuevo! 🎁');
        return;
      }

      if (texto.startsWith('ASIGNAR ')) {
        const partes = texto.split(' ');
        if (partes.length < 3) { await enviarMensaje(telefono, '❌ Usa: ASIGNAR DESP-000002 DESP-000001'); return; }
        const nuevoResp = partes[1];
        const anteriorResp = partes[2];
        let count = 0;
        db.usuarios.forEach(function(u, i) {
          if (u.referidoPor === anteriorResp && u.congelado) {
            db.usuarios[i].referidoPor = nuevoResp;
            db.usuarios[i].congelado = false;
            count++;
          }
        });
        guardarDB(db);
        await enviarMensaje(telefono, '✅ ' + count + ' referido(s) reasignados correctamente.');
        return;
      }

      if (texto === 'CONGELADOS') {
        const congelados = db.usuarios.filter(function(u) { return u.congelado; });
        if (congelados.length === 0) { await enviarMensaje(telefono, '✅ No hay referidos congelados.'); return; }
        const lista = congelados.map(function(u) { return '• ' + u.id + ' — ' + u.nombre; }).join('\n');
        await enviarMensaje(telefono, '❄️ *REFERIDOS CONGELADOS*\n\n' + lista);
        return;
      }

      if (texto === 'REPORTE') {
        const total = db.usuarios.length;
        const activos = db.usuarios.filter(function(u) { return u.activo; }).length;
        const conPago = db.usuarios.filter(function(u) { return u.pagos.some(function(p) { return p.estado === 'confirmado'; }); }).length;
        await enviarMensaje(telefono,
          '📊 *REPORTE GENERAL*\n\n' +
          '👥 Total usuarios: ' + total + '\n' +
          '✅ Activos: ' + activos + '\n' +
          '💰 Con pago confirmado: ' + conPago + '\n' +
          '⏳ Sin pago: ' + (total - conPago) + '\n\n' +
          'Fecha: ' + new Date().toLocaleDateString('es-MX')
        );
        return;
      }

      if (texto === 'LISTA') {
        if (db.usuarios.length === 0) { await enviarMensaje(telefono, '📋 No hay usuarios registrados.'); return; }
        const lista = db.usuarios.slice(-10).map(function(u) {
          return (u.activo ? '✅' : '❌') + ' ' + u.id + ' — ' + u.nombre + ' — Nv.' + (u.nivel || 0) + ' — ' + u.referidos.length + '/4';
        }).join('\n');
        await enviarMensaje(telefono, '📋 *ULTIMOS 10 USUARIOS*\n\n' + lista + '\n\nTotal: ' + db.usuarios.length);
        return;
      }
    }

    // ── MENU POR DEFECTO
    delete sesiones[telefono];
    await enviarMensaje(telefono, menuPrincipal());

  } catch (err) {
    console.error('Error procesando mensaje:', err.message);
  }
}

// ============================================================
// WEBHOOK
// ============================================================
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const data = req.body;
    if (!data) return;

    // Log full body for debugging
    console.log('Webhook recibido:', JSON.stringify(data).substring(0, 300));

    var telefono = null;
    var mensaje = null;
    var fromMe = false;

    // WasenderAPI formato real confirmado
    if (data.event === 'messages.received' && data.data) {
      var d = data.data;
      var messages = d.messages || d.message || d;
      var key = messages.key || {};
      fromMe = key.fromMe || false;
      if (fromMe) return;
      // Teléfono: usar cleanedSenderPn o senderPn del key
      telefono = key.cleanedSenderPn || key.senderPn || key.remoteJid || null;
      // Mensaje: buscar en message.conversation
      var msgContent = messages.message || messages.mensaje || {};
      mensaje = msgContent.conversation ||
                (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
                messages.body || messages.text || null;
      console.log('Tel: ' + telefono + ' | Msg: ' + mensaje);
    }
    // Formato español
    else if (data.evento && data.datos) {
      var d = data.datos;
      var mensajes = d.mensajes || {};
      var clave = mensajes.clave || {};
      fromMe = clave.fromMe || false;
      if (fromMe) return;
      telefono = clave.cleanedSenderPn || clave.senderPn || clave.remoteJid || null;
      var msgObj = mensajes.mensaje || mensajes.message || {};
      mensaje = msgObj.conversation ||
                (msgObj.extendedTextMessage && msgObj.extendedTextMessage.text) ||
                mensajes.body || null;
      console.log('Tel esp: ' + telefono + ' | Msg: ' + mensaje);
    }
    // UltraMsg / generic format
    else if (data.data) {
      var msg = data.data;
      fromMe = msg.fromMe || msg.from_me || false;
      if (fromMe) return;
      telefono = msg.from || msg.sender || msg.chatId;
      mensaje = msg.body || msg.text || msg.content;
    }
    // Direct format
    else {
      fromMe = data.fromMe || data.from_me || false;
      if (fromMe) return;
      telefono = data.from || data.sender || data.chatId;
      mensaje = data.body || data.text || data.content;
    }

    if (!telefono || !mensaje) {
      console.log('Sin telefono o mensaje en webhook');
      return;
    }
    if (String(telefono).includes('@g.us')) return;

    console.log('Mensaje de ' + telefono + ': ' + mensaje);
    await procesarMensaje(telefono, mensaje);
  } catch (err) {
    console.error('Error en webhook:', err.message);
  }
});

app.get('/', function(req, res) {
  res.send('Bot DespensaClub Familiar funcionando correctamente.');
});

const PORT = process.env.PORT || process.env.RAILWAY_TCP_PROXY_PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Bot corriendo en puerto ' + PORT);
});
