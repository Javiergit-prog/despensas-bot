const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const nodeCrypto = require('crypto');

// ============================================================
// CONEXION A MONGODB
// ============================================================
const MONGODB_URI = process.env.MONGODB_URI || '';

mongoose.connect(MONGODB_URI)
  .then(function() { 
    console.log('✅ Conectado a MongoDB Atlas');
    iniciarRespaldoDiario();
  })
  .catch(function(err) { console.error('❌ Error MongoDB:', err.message); });

// ============================================================
// MODELO DE USUARIO EN MONGODB
// ============================================================
const usuarioSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  nombre: String,
  telefono: String,
  telefonoLimpio: String,
  referidoPor: String,
  nivel: { type: Number, default: 0 },
  referidos: [String],
  fechaRegistro: { type: Date, default: Date.now },
  vigencia: Date,
  pagos: [{
    monto: Number,
    fecha: Date,
    estado: String
  }],
  consumos: [{
    fecha: Date,
    descripcion: String
  }],
  activo: { type: Boolean, default: true },
  congelado: { type: Boolean, default: false }
});

const Usuario = mongoose.model('Usuario', usuarioSchema);

// ============================================================
// MODELO DE CONTADOR EN MONGODB
// ============================================================
const contadorSchema = new mongoose.Schema({
  nombre: { type: String, unique: true },
  valor: { type: Number, default: 109 }
});

const Contador = mongoose.model('Contador', contadorSchema);

async function obtenerSiguienteContador() {
  // Si no existe, lo crea con valor 109 antes de incrementar
  await Contador.findOneAndUpdate(
    { nombre: 'usuarios' },
    { $setOnInsert: { valor: 109 } },
    { upsert: true, new: true }
  );
  const contador = await Contador.findOneAndUpdate(
    { nombre: 'usuarios' },
    { $inc: { valor: 1 } },
    { new: true }
  );
  return contador.valor;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURACION
// ============================================================
const WASENDER_TOKEN = process.env.WASENDER_TOKEN || '';
const WASENDER_URL = 'https://api.wasenderapi.com/api/send-message';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';

const COLORES_NIVEL = {
  0: 'VIOLETA', 1: 'DORADO', 2: 'AZUL',
  3: 'NARANJA', 4: 'ROSA', 5: 'VERDE',
  6: 'AMARILLO', 7: 'TURQUESA', 8: 'VERDE BANDERA', 9: 'GRIS'
};

// ============================================================
// FUNCIONES DE BASE DE DATOS (MongoDB)
// ============================================================
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
// FUNCION DE RESPALDO AUTOMATICO DIARIO
// ============================================================
async function enviarRespaldoDiario() {
  try {
    console.log('Iniciando respaldo diario...');
    const usuarios = await Usuario.find({});
    const total = usuarios.length;
    const activos = usuarios.filter(function(u) { return u.activo; }).length;
    const inactivos = total - activos;
    const conPago = usuarios.filter(function(u) {
      return u.pagos && u.pagos.some(function(p) { return p.estado === 'confirmado'; });
    }).length;
    const fecha = new Date().toLocaleDateString('es-MX', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    const mensaje =
      '📦 *RESPALDO NOCTURNO DESPENSACLUB*\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '📅 ' + fecha + '\n\n' +
      '👥 Total usuarios: *' + total + '*\n' +
      '✅ Activos: *' + activos + '*\n' +
      '❌ Inactivos: *' + inactivos + '*\n' +
      '💰 Con pago confirmado: *' + conPago + '*\n' +
      '⏳ Sin pago: *' + (total - conPago) + '*\n\n' +
      '💾 Base de datos: MongoDB Atlas ✅\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '_DespensaClub Bot — Respaldo automático_';

    await enviarMensaje('5215585567250', mensaje);
    console.log('✅ Respaldo enviado por WhatsApp a 5215585567250');
  } catch (err) {
    console.error('❌ Error enviando respaldo:', err.message);
  }
}

// Programar respaldo diario a las 11 PM hora Mexico (5 AM UTC)
function iniciarRespaldoDiario() {
  var ahora = new Date();
  var proximaEjecucion = new Date();
  proximaEjecucion.setUTCHours(5, 0, 0, 0); // 11 PM Mexico = 5 AM UTC
  if (proximaEjecucion <= ahora) {
    proximaEjecucion.setDate(proximaEjecucion.getDate() + 1);
  }
  var tiempoEspera = proximaEjecucion - ahora;
  console.log('Proximo respaldo en ' + Math.round(tiempoEspera/1000/60) + ' minutos');
  setTimeout(function() {
    enviarRespaldoDiario();
    setInterval(enviarRespaldoDiario, 24 * 60 * 60 * 1000); // cada 24 horas
  }, tiempoEspera);
}

// ============================================================
// SISTEMA OTP — LOGIN SEGURO ADMIN
// ============================================================
const otpSesiones = {}; // { telefono: { codigo, expira } }

function generarOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function otpValido(telefono, codigo) {
  const otp = otpSesiones[telefono];
  if (!otp) return false;
  if (Date.now() > otp.expira) {
    delete otpSesiones[telefono];
    return false;
  }
  if (otp.codigo !== codigo) return false;
  delete otpSesiones[telefono];
  return true;
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
    const texto = mensaje.trim();
    const sesion = sesiones[telefono] || { paso: 'menu' };
    const telLimpio = String(telefono).replace('@s.whatsapp.net', '').replace('@c.us', '');
    const usuarioExistente = await Usuario.findOne({ telefono: telefono });

    // ── COMANDO ADMIN RAPIDO (funciona desde cualquier paso)
    const esSuperAdmin = (
      String(telefono).includes('5576683884') ||
      String(telLimpio).includes('5576683884') ||
      ADMIN_PHONE.includes(String(telLimpio).slice(-10))
    );

    // OTP puede mandarse desde cualquier teléfono de confianza
    const esConfianza = (
      String(telefono).includes('5559651830') ||
      String(telefono).includes('5585567250') ||
      String(telefono).includes('5576683884') ||
      ADMIN_PHONE.includes(String(telLimpio).slice(-10))
    );

    if (texto === 'OTP' && esConfianza) {
      const codigo = generarOTP();
      otpSesiones['admin'] = { codigo: codigo, expira: Date.now() + 5 * 60 * 1000 };
      await enviarMensaje('5215585567250',
        '🔐 *CÓDIGO DE ACCESO ADMIN*\n\n' +
        'Tu código OTP es:\n\n' +
        '*' + codigo + '*\n\n' +
        '⏱️ Válido por *5 minutos*\n' +
        '⚠️ No lo compartas con nadie.'
      );
      return;
    }

    if (texto === 'RESETBD' && esSuperAdmin) {
      await Usuario.deleteMany({});
      await Contador.deleteMany({});
      await Contador.create({ nombre: 'usuarios', valor: 109 });
      Object.keys(sesiones).forEach(k => delete sesiones[k]);
      await enviarMensaje(telefono, '✅ Base de datos limpiada. Contador reiniciado en DESP-000110.');
      return;
    }

    if (texto === 'REPORTE' && esSuperAdmin) {
      const total = await Usuario.countDocuments();
      const activos = await Usuario.countDocuments({ activo: true });
      const conPago = await Usuario.countDocuments({ 'pagos.estado': 'confirmado' });
      await enviarMensaje(telefono, '📊 REPORTE GENERAL\n\nTotal: ' + total + '\nActivos: ' + activos + '\nCon pago: ' + conPago + '\nSin pago: ' + (total - conPago));
      return;
    }

    if (texto === 'LISTA' && esSuperAdmin) {
      const total = await Usuario.countDocuments();
      if (total === 0) { await enviarMensaje(telefono, 'No hay usuarios.'); return; }
      const ultimos = await Usuario.find().sort({ fechaRegistro: -1 }).limit(10);
      const lista = ultimos.map(function(u) {
        return (u.activo ? 'OK' : 'XX') + ' ' + u.id + ' ' + u.nombre + ' Nv.' + (u.nivel||0);
      }).join('\n');
      await enviarMensaje(telefono, 'ULTIMOS 10 USUARIOS\n\n' + lista + '\n\nTotal: ' + total);
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
      // Corrección automática del nombre
      const nombreCorregido = texto
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .replace(/(?:^|\s)\S/g, l => l.toUpperCase());

      // Antifraude: bloquear nombre duplicado o muy similar
      const todosUsuarios = await Usuario.find({}, 'nombre id');
      const nombreLimpio = nombreCorregido.toLowerCase().replace(/\s/g, '');
      const duplicadoNombre = todosUsuarios.find(u => {
        const uNombre = u.nombre.toLowerCase().replace(/\s/g, '');
        const coincidencias = [...nombreLimpio].filter(c => uNombre.includes(c)).length;
        const similitud = coincidencias / Math.max(nombreLimpio.length, uNombre.length);
        return similitud > 0.85 && uNombre.length > 4;
      });

      if (duplicadoNombre) {
        delete sesiones[telefono];
        await enviarMensaje(telefono,
          '⛔ *REGISTRO NO PERMITIDO*\n\n' +
          'Ya existe un usuario registrado con ese nombre.\n\n' +
          'Si crees que es un error contacta al administrador:\n' +
          'https://wa.me/525576683884'
        );
        return;
      }

      sesiones[telefono] = { paso: 'pedir_referido', datos: { nombre: nombreCorregido } };
      await enviarMensaje(telefono, '👍 Gracias *' + nombreCorregido + '*.\n\n¿Tienes un codigo de quien te invito?\n(Ejemplo: DESP-000001)\n\nSi no tienes codigo escribe *NO*');
      return;
    }

    // ── REGISTRO PASO 3 - REFERIDO
    if (sesion.paso === 'pedir_referido') {
      const codigoReferido = texto.toUpperCase();
      let referidoPor = null;

      if (codigoReferido !== 'NO') {
        const referidor = await Usuario.findOne({ id: codigoReferido });
        if (!referidor) {
          await enviarMensaje(telefono, '❌ No encontre ese codigo. Verifica e intenta de nuevo.\n\nO escribe *NO* si no tienes codigo.');
          return;
        }
        // Verificar si el referidor ya tiene 4 referidos
        const refCount = referidor.referidos ? referidor.referidos.length : 0;
        if (refCount >= 4) {
          await enviarMensaje(telefono,
            '⛔ *CODIGO NO DISPONIBLE*\n\n' +
            'El usuario con ese codigo ya completo sus 4 lugares disponibles.\n\n' +
            'Contacta al administrador para mas informacion:\n' +
            'https://wa.me/525576683884?text=Hola%20necesito%20ayuda%20con%20un%20registro'
          );
          return;
        }
        referidoPor = codigoReferido;
      }

      // Calcular nivel
      let nivelUsuario = 0;
      if (referidoPor) {
        const referidor = await Usuario.findOne({ id: referidoPor });
        nivelUsuario = referidor ? (referidor.nivel || 0) + 1 : 1;
      }

      const contadorVal = await obtenerSiguienteContador();
      const nuevoID = generarID(contadorVal);
      const fechaRegistro = new Date();
      const fechaVigencia = new Date(fechaRegistro);
      fechaVigencia.setFullYear(fechaVigencia.getFullYear() + 1);
      const nuevoUsuario = new Usuario({
        id: nuevoID,
        nombre: sesion.datos.nombre,
        telefono: telefono,
        telefonoLimpio: telLimpio,
        referidoPor: referidoPor,
        nivel: nivelUsuario,
        referidos: [],
        fechaRegistro: fechaRegistro,
        vigencia: fechaVigencia,
        pagos: [],
        consumos: [],
        activo: true
      });

      // Actualizar referidos del invitador
      if (referidoPor) {
        const referidor = await Usuario.findOne({ id: referidoPor });
        if (referidor) {
          await Usuario.updateOne({ id: referidoPor }, { $push: { referidos: nuevoID } });
          const totalReferidos = referidor.referidos.length + 1;
          await enviarMensaje(referidor.telefono,
            '🎉 Tienes un nuevo referido!\n*' + nuevoUsuario.nombre + '* se registro con tu codigo.\nYa tienes *' + totalReferidos + '* de 4 referidos.'
          );
        }
      }

      await nuevoUsuario.save();
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

      await enviarMensaje('5215585567250',
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
      const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'N/A';
      await enviarMensaje(telefono,
        '👤 *TU INFORMACION*\n\n' +
        '🪪 ID: *' + u.id + '*\n' +
        '👤 Nombre: ' + u.nombre + '\n' +
        '🎨 Nivel: ' + (u.nivel || 0) + ' — ' + color + '\n' +
        '👥 Referidos: ' + u.referidos.length + '/4\n' +
        '📅 Registro: ' + new Date(u.fechaRegistro).toLocaleDateString('es-MX') + '\n' +
        '⏳ Vigencia: ' + vigenciaStr + '\n' +
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

      // Bloquear si ya tiene 4 referidos
      if (u.referidos.length >= 4) {
        await enviarMensaje(telefono,
          '⛔ *YA COMPLETASTE TUS 4 REFERIDOS*\n\n' +
          'Tu estructura esta completa con:\n' +
          u.referidos.map(function(r, i) { return (i+1) + '. ' + r; }).join('\n') + '\n\n' +
          'Si deseas hacer algun cambio comunicate directamente con el administrador.\n\n' +
          '📱 Contactar admin:\nhttps://wa.me/525576683884?text=Hola%20necesito%20ayuda%20con%20mis%20referidos'
        );
        return;
      }
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
      await Usuario.updateOne(
        { telefono: telefono },
        { $push: { pagos: { monto: monto, fecha: new Date(), estado: 'pendiente_confirmacion' } } }
      );
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
      ADMIN_PHONE.includes(String(telLimpio).slice(-10))
    );

    if (esAdmin) {

      if (texto === 'RESPALDO') {
        await enviarMensaje(telefono, '📧 Enviando respaldo a tu correo...');
        await enviarRespaldoDiario();
        await enviarMensaje(telefono, '✅ Respaldo enviado a ' + CORREO_ADMIN);
        return;
      }

      if (texto === 'RESETBD') {
        await Usuario.deleteMany({});
        await Contador.deleteMany({});
        await Contador.create({ nombre: 'usuarios', valor: 109 });
        Object.keys(sesiones).forEach(k => delete sesiones[k]);
        await enviarMensaje(telefono, '✅ Base de datos limpiada. Contador reiniciado en DESP-000110.');
        return;
      }

      if (texto.startsWith('CONFIRMAR ')) {
        const idU = texto.split(' ')[1];
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        const pagoIdx = userU.pagos.findLastIndex(function(p) { return p.estado === 'pendiente_confirmacion'; });
        if (pagoIdx === -1) { await enviarMensaje(telefono, '❌ No hay pagos pendientes para ' + idU); return; }
        userU.pagos[pagoIdx].estado = 'confirmado';
        await userU.save();
        await enviarMensaje(telefono, '✅ Pago de ' + userU.nombre + ' confirmado.');
        await enviarMensaje(userU.telefono, '✅ *TU PAGO FUE CONFIRMADO*\n\nMonto: $' + userU.pagos[pagoIdx].monto + '\nGracias ' + userU.nombre + '! 🎁');
        return;
      }

      if (texto.startsWith('CONSUMO ')) {
        const idU = texto.split(' ')[1];
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        await Usuario.updateOne({ id: idU }, { $push: { consumos: { fecha: new Date(), descripcion: 'Despensa mensual' } } });
        await enviarMensaje(telefono, '✅ Consumo registrado para ' + userU.nombre + ' (' + idU + ')');
        await enviarMensaje(userU.telefono, '📦 *DESPENSA REGISTRADA*\n\nHola ' + userU.nombre + ', tu despensa fue registrada.\nFecha: ' + new Date().toLocaleDateString('es-MX') + ' 🎁');
        return;
      }

      if (texto.startsWith('DESACTIVAR ')) {
        const idU = texto.split(' ')[1];
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        await Usuario.updateOne({ id: idU }, { activo: false });
        const congelados = await Usuario.find({ referidoPor: idU });
        await Usuario.updateMany({ referidoPor: idU }, { congelado: true });
        await enviarMensaje(telefono, '✅ Usuario ' + userU.nombre + ' desactivado.\nReferidos congelados: ' + congelados.length);
        await enviarMensaje(userU.telefono, '⚠️ Tu cuenta ha sido suspendida.\nContacta al administrador.');
        return;
      }

      if (texto.startsWith('ACTIVAR ')) {
        const idU = texto.split(' ')[1];
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontre el usuario ' + idU); return; }
        await Usuario.updateOne({ id: idU }, { activo: true });
        await enviarMensaje(telefono, '✅ Usuario ' + userU.nombre + ' reactivado.');
        await enviarMensaje(userU.telefono, '✅ Tu cuenta ha sido reactivada. Bienvenido de nuevo! 🎁');
        return;
      }

      if (texto.startsWith('ASIGNAR ')) {
        const partes = texto.split(' ');
        if (partes.length < 3) { await enviarMensaje(telefono, '❌ Usa: ASIGNAR DESP-000002 DESP-000001'); return; }
        const nuevoResp = partes[1];
        const anteriorResp = partes[2];
        const result = await Usuario.updateMany(
          { referidoPor: anteriorResp, congelado: true },
          { referidoPor: nuevoResp, congelado: false }
        );
        await enviarMensaje(telefono, '✅ ' + result.modifiedCount + ' referido(s) reasignados correctamente.');
        return;
      }

      if (texto === 'CONGELADOS') {
        const congelados = await Usuario.find({ congelado: true });
        if (congelados.length === 0) { await enviarMensaje(telefono, '✅ No hay referidos congelados.'); return; }
        const lista = congelados.map(function(u) { return '• ' + u.id + ' — ' + u.nombre; }).join('\n');
        await enviarMensaje(telefono, '❄️ *REFERIDOS CONGELADOS*\n\n' + lista);
        return;
      }

      if (texto === 'REPORTE') {
        const total = await Usuario.countDocuments();
        const activos = await Usuario.countDocuments({ activo: true });
        const conPago = await Usuario.countDocuments({ 'pagos.estado': 'confirmado' });
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
        const total = await Usuario.countDocuments();
        if (total === 0) { await enviarMensaje(telefono, '📋 No hay usuarios registrados.'); return; }
        const ultimos = await Usuario.find().sort({ fechaRegistro: -1 }).limit(10);
        const lista = ultimos.map(function(u) {
          return (u.activo ? '✅' : '❌') + ' ' + u.id + ' — ' + u.nombre + ' — Nv.' + (u.nivel || 0) + ' — ' + u.referidos.length + '/4';
        }).join('\n');
        await enviarMensaje(telefono, '📋 *ULTIMOS 10 USUARIOS*\n\n' + lista + '\n\nTotal: ' + total);
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
    console.log('Webhook COMPLETO:', JSON.stringify(data));

    var telefono = null;
    var mensaje = null;
    var fromMe = false;

    // Formato español (WasenderAPI en español)
    if (data.evento === 'mensajes.recibidos' && data.datos) {
      var mensajes = data.datos.mensajes || {};
      var clave = mensajes.clave || {};
      fromMe = clave.fromMe || false;
      if (fromMe) return;
      // Teléfono desde cleanedSenderPn o senderPn
      telefono = data.datos.mensajes.cleanedSenderPn ||
                 data.datos.mensajes.senderPn ||
                 clave.remoteJid || null;
      // Texto del mensaje
      var msgObj = mensajes.mensaje || mensajes.message || {};
      mensaje = msgObj.conversation ||
                (msgObj.extendedTextMessage && msgObj.extendedTextMessage.text) ||
                mensajes.texto || mensajes.body || mensajes.text || null;
      console.log('Tel esp: ' + telefono + ' | Msg: ' + mensaje);
    }
    // Formato inglés (WasenderAPI en inglés)
    else if (data.event === 'messages.received' && data.data) {
      var d = data.data;
      var messages = d.messages || d.message || d;
      var key = messages.key || {};
      fromMe = key.fromMe || false;
      if (fromMe) return;
      // El teléfono limpio está en key.cleanedSenderPn según el JSON real
      telefono = key.cleanedSenderPn || key.senderPn || messages.cleanedSenderPn || messages.senderPn || key.remoteJid || null;
      var msgContent = messages.message || {};
      mensaje = msgContent.conversation ||
                (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
                messages.messageBody ||
                messages.body || messages.text || null;
      console.log('Tel: ' + telefono + ' | Msg: ' + mensaje);
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

app.get('/admin/arbol', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const usuarios = await Usuario.find({}).lean();

    const COLORES_HEX = {
      0: { bg: '#7B2FBE', text: '#fff', nombre: 'VIOLETA' },
      1: { bg: '#F5A623', text: '#000', nombre: 'DORADO' },
      2: { bg: '#2196F3', text: '#fff', nombre: 'AZUL' },
      3: { bg: '#FF6B2B', text: '#fff', nombre: 'NARANJA' },
      4: { bg: '#E91E8C', text: '#fff', nombre: 'ROSA' },
      5: { bg: '#4CAF50', text: '#fff', nombre: 'VERDE' },
      6: { bg: '#FFC107', text: '#000', nombre: 'AMARILLO' },
      7: { bg: '#00BCD4', text: '#000', nombre: 'TURQUESA' },
      8: { bg: '#1B5E20', text: '#fff', nombre: 'VERDE BANDERA' },
      9: { bg: '#9E9E9E', text: '#fff', nombre: 'GRIS' }
    };

    function buildNodo(usuario, todos) {
      const color = COLORES_HEX[usuario.nivel || 0] || COLORES_HEX[0];
      const referidos = todos.filter(u => u.referidoPor === usuario.id);
      const refsHTML = referidos.map(r => buildNodo(r, todos)).join('');
      return `
        <div class="nodo-wrap">
          <div class="nodo" style="background:${color.bg};color:${color.text}">
            <div class="nodo-id">${usuario.id}</div>
            <div class="nodo-nombre">${usuario.nombre}</div>
            <div class="nodo-nivel">Nv.${usuario.nivel||0} — ${color.nombre}</div>
            <div class="nodo-refs">${usuario.referidos ? usuario.referidos.length : 0}/4 referidos</div>
            <div class="nodo-estado">${usuario.activo ? '✅ Activo' : '❌ Inactivo'}</div>
          </div>
          ${refsHTML ? `<div class="hijos">${refsHTML}</div>` : ''}
        </div>`;
    }

    const raices = usuarios.filter(u => !u.referidoPor);
    const arbolHTML = raices.map(u => buildNodo(u, usuarios)).join('');

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🛒 DespensaClub — Árbol Jerárquico</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 20px; min-height: 100vh; }
    h1 { text-align: center; color: #25D366; margin-bottom: 5px; font-size: 22px; }
    .subtitulo { text-align: center; color: #aaa; font-size: 13px; margin-bottom: 25px; }
    .stats { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; margin-bottom: 25px; }
    .stat { background: #16213e; border-radius: 10px; padding: 10px 20px; text-align: center; }
    .stat-num { font-size: 24px; font-weight: bold; color: #25D366; }
    .stat-label { font-size: 11px; color: #aaa; }
    .arbol { overflow-x: auto; padding-bottom: 20px; }
    .nodo-wrap { display: inline-flex; flex-direction: column; align-items: center; margin: 0 8px; }
    .nodo { border-radius: 12px; padding: 10px 14px; min-width: 140px; max-width: 160px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.4); margin-bottom: 8px; cursor: default; transition: transform 0.2s; }
    .nodo:hover { transform: scale(1.05); }
    .nodo-id { font-size: 11px; opacity: 0.8; margin-bottom: 3px; }
    .nodo-nombre { font-size: 13px; font-weight: bold; margin-bottom: 3px; word-break: break-word; }
    .nodo-nivel { font-size: 10px; opacity: 0.85; margin-bottom: 3px; }
    .nodo-refs { font-size: 11px; opacity: 0.8; }
    .nodo-estado { font-size: 10px; margin-top: 3px; }
    .hijos { display: flex; flex-direction: row; align-items: flex-start; justify-content: center; border-top: 2px solid #444; padding-top: 8px; margin-top: 0; position: relative; }
    .hijos::before { content: ''; position: absolute; top: 0; left: 50%; width: 2px; height: 8px; background: #444; }
    .vacio { text-align: center; color: #666; margin-top: 60px; font-size: 18px; }
    .leyenda { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 25px; }
    .leyenda-item { border-radius: 20px; padding: 4px 12px; font-size: 11px; font-weight: bold; }
    .btn-refresh { display: block; margin: 20px auto 0; padding: 10px 25px; background: #25D366; color: #000; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: bold; }
  </style>
</head>
<body>
  <h1>🛒 DespensaClub Familiar</h1>
  <p class="subtitulo">Árbol Jerárquico de Usuarios</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-num">${usuarios.length}</div>
      <div class="stat-label">Total usuarios</div>
    </div>
    <div class="stat">
      <div class="stat-num">${usuarios.filter(u => u.activo).length}</div>
      <div class="stat-label">Activos</div>
    </div>
    <div class="stat">
      <div class="stat-num">${raices.length}</div>
      <div class="stat-label">Raíces</div>
    </div>
    <div class="stat">
      <div class="stat-num">${Math.max(...usuarios.map(u => u.nivel || 0), 0)}</div>
      <div class="stat-label">Nivel máximo</div>
    </div>
  </div>

  <div class="leyenda">
    ${Object.entries(COLORES_HEX).map(([n, c]) =>
      `<span class="leyenda-item" style="background:${c.bg};color:${c.text}">Nv.${n} ${c.nombre}</span>`
    ).join('')}
  </div>

  <div class="arbol">
    ${arbolHTML || '<div class="vacio">😴 No hay usuarios registrados aún.</div>'}
  </div>

  <button class="btn-refresh" onclick="location.reload()">🔄 Actualizar</button>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/login', function(req, res) {
  const otp = req.query.otp;
  const tel = req.query.tel || '5576683884';
  if (!otp) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center">
        <h2>🔐 DespensaClub Admin</h2>
        <p>Primero manda <b>OTP</b> por WhatsApp al bot para recibir tu código.</p>
        <form method="GET">
          <input name="otp" placeholder="Ingresa tu código de 6 dígitos" 
            style="padding:10px;font-size:18px;width:200px;text-align:center;letter-spacing:8px">
          <input name="tel" type="hidden" value="${tel}">
          <br><br>
          <button type="submit" style="padding:10px 30px;background:#25D366;color:white;border:none;border-radius:5px;font-size:16px;cursor:pointer">
            Entrar
          </button>
        </form>
      </body></html>
    `);
  }
  if (otpValido('admin', otp)) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:50px auto;text-align:center">
        <h2>✅ Acceso autorizado</h2>
        <p>Bienvenido al panel de administración DespensaClub.</p>
        <p><a href="/admin/lista?key=despensas2026">📋 Ver lista de usuarios</a></p>
        <p><a href="/admin/arbol?key=despensas2026">🌳 Ver árbol jerárquico</a></p>
        <p><a href="/admin/respaldo?key=despensas2026">📦 Enviar respaldo</a></p>
        <p><a href="/admin/resetbd?key=despensas2026">🗑️ Reset base de datos</a></p>
      </body></html>
    `);
  }
  return res.send(`
    <html><body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center">
      <h2>❌ Código incorrecto o expirado</h2>
      <p>Manda <b>OTP</b> nuevamente por WhatsApp para obtener un código nuevo.</p>
      <a href="/admin/login">Intentar de nuevo</a>
    </body></html>
  `);
});

app.get('/admin/resetbd', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    await Usuario.deleteMany({});
    await Contador.deleteMany({});
    await Contador.create({ nombre: 'usuarios', valor: 109 });
    Object.keys(sesiones).forEach(k => delete sesiones[k]);
    res.send('✅ Base de datos limpiada. Contador reiniciado en DESP-000110.');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/respaldo', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    await enviarRespaldoDiario();
    res.send('✅ Respaldo enviado por WhatsApp al número del negocio.');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/lista', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const usuarios = await Usuario.find({}).sort({ fechaRegistro: -1 });
    const lista = usuarios.map(u =>
      `${u.id} | ${u.nombre} | Tel: ${u.telefonoLimpio} | Nv.${u.nivel} | ${u.activo ? 'Activo' : 'Inactivo'} | Refs: ${u.referidos.length}/4`
    ).join('\n');
    res.send(`Total: ${usuarios.length}\n\n${lista || 'Sin usuarios'}`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/', function(req, res) {
  res.send('Bot DespensaClub Familiar funcionando correctamente.');
});

// ============================================================
// MONITOREO Y RECONEXIÓN AUTOMÁTICA DE WHATSAPP
// ============================================================
const WASENDER_STATUS_URL = 'https://www.wasenderapi.com/api/status';
let estadoConexion = 'desconocido';
let avisoEnviado = false;

async function verificarConexionWhatsApp() {
  try {
    const resp = await axios.get(WASENDER_STATUS_URL, {
      headers: { 'Authorization': 'Bearer ' + WASENDER_TOKEN }
    });
    const status = resp.data && resp.data.status;
    console.log('Estado WhatsApp: ' + status);

    if (status === 'connected') {
      if (estadoConexion !== 'conectado' && avisoEnviado) {
        await enviarMensaje('5215585567250', '✅ *WhatsApp reconectado*\n\nEl bot está funcionando nuevamente.');
        avisoEnviado = false;
      }
      estadoConexion = 'conectado';
    } else {
      console.log('⚠️ WhatsApp desconectado. Estado: ' + status);
      if (!avisoEnviado) {
        await enviarMensaje('5215585567250',
          '⚠️ *ALERTA — Bot desconectado*\n\n' +
          'Estado: ' + status + '\n\n' +
          '📱 Para reconectar:\n' +
          '1. Ve a wasenderapi.com\n' +
          '2. Inicia sesión\n' +
          '3. Escanea el código QR\n\n' +
          'El bot no responderá hasta reconectarse.'
        );
        avisoEnviado = true;
      }
      estadoConexion = 'desconectado';
    }
  } catch (err) {
    console.log('⚠️ Error verificando conexión WhatsApp:', err.message);
  }
}

// Verificar conexión cada 5 minutos
setInterval(verificarConexionWhatsApp, 5 * 60 * 1000);
// Primera verificación al iniciar (esperar 30 segundos)
setTimeout(verificarConexionWhatsApp, 30 * 1000);

const PORT = process.env.PORT || process.env.RAILWAY_TCP_PROXY_PORT || 3000;
app.listen(PORT, '0.0.0.0', function() {
  console.log('Bot corriendo en puerto ' + PORT);
});
