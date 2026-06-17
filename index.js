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
    concepto: String,
    fecha: Date,
    estado: String,
    comprobante: String
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
// RECORDATORIOS AUTOMÁTICOS DE PAGO
// ============================================================
async function enviarRecordatorios() {
  try {
    console.log('Verificando recordatorios...');
    const hoy = new Date();
    const dia = hoy.getDate();
    const usuarios = await Usuario.find({ activo: true });

    // Día 1 — generar lista mensual de despensas
    if (dia === 1) {
      await generarListaMensual();
    }

    // Día 30 — reporte mensual
    if (dia === 30) {
      await enviarReporteMensual();
    }

    for (const u of usuarios) {
      // Recordatorio día 1 de cada mes — usuarios sin pago del mes actual
      if (dia === 1) {
        const mesActual = hoy.getMonth();
        const anioActual = hoy.getFullYear();
        const pagosEsteMes = u.pagos ? u.pagos.filter(p => {
          const fechaPago = new Date(p.fecha);
          return p.estado === 'confirmado' &&
                 p.concepto === 'Despensa mensual' &&
                 fechaPago.getMonth() === mesActual &&
                 fechaPago.getFullYear() === anioActual;
        }) : [];

        if (pagosEsteMes.length === 0) {
          await enviarMensaje(u.telefono,
            '📅 *RECORDATORIO DE PAGO*\n\n' +
            'Hola *' + u.nombre + '* 👋\n\n' +
            'Recuerda que este mes aún no hemos recibido tu pago de despensa.\n\n' +
            '💵 Despensa mensual: *$250 pesos*\n\n' +
            'Para registrar tu pago escribe *MENU* y elige la opción *4*.\n\n' +
            '¡Gracias por ser parte de DespensaClub! 🛒'
          );
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Recordatorio 30 días antes del vencimiento de membresía
      if (u.vigencia) {
        const vigencia = new Date(u.vigencia);
        const diasRestantes = Math.ceil((vigencia - hoy) / (1000 * 60 * 60 * 24));

        if (diasRestantes === 30 || diasRestantes === 7 || diasRestantes === 1) {
          await enviarMensaje(u.telefono,
            '⚠️ *TU MEMBRESÍA ESTÁ POR VENCER*\n\n' +
            'Hola *' + u.nombre + '* 👋\n\n' +
            'Tu membresía anual vence en *' + diasRestantes + ' día(s)*.\n' +
            '📅 Vencimiento: ' + vigencia.toLocaleDateString('es-MX') + '\n\n' +
            '💵 Renovación: *$50 pesos*\n\n' +
            'Para renovar escribe *MENU* y elige la opción *4*.\n\n' +
            'No pierdas tu lugar en DespensaClub 🛒'
          );
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    console.log('✅ Recordatorios enviados');
  } catch (err) {
    console.error('❌ Error enviando recordatorios:', err.message);
  }
}

// Ejecutar recordatorios diario a las 9 AM hora Mexico (3 PM UTC)
function iniciarRecordatorios() {
  var ahora = new Date();
  var proximaEjecucion = new Date();
  proximaEjecucion.setUTCHours(15, 0, 0, 0); // 9 AM Mexico = 3 PM UTC
  if (proximaEjecucion <= ahora) {
    proximaEjecucion.setDate(proximaEjecucion.getDate() + 1);
  }
  var tiempoEspera = proximaEjecucion - ahora;
  console.log('Próximos recordatorios en ' + Math.round(tiempoEspera/1000/60) + ' minutos');
  setTimeout(function() {
    enviarRecordatorios();
    setInterval(enviarRecordatorios, 24 * 60 * 60 * 1000);
  }, tiempoEspera);
}

// ============================================================
// CONGELAMIENTO AUTOMÁTICO
// ============================================================
const USUARIOS_EXENTOS = ['DESP-000110', 'DESP-000111']; // Nunca se congelan

async function verificarCongelamiento() {
  try {
    console.log('Verificando congelamientos...');
    const hoy = new Date();
    const usuarios = await Usuario.find({ activo: true, congelado: false });

    for (const u of usuarios) {
      // Saltar usuarios exentos
      if (USUARIOS_EXENTOS.includes(u.id)) continue;

      // Verificar si tiene pago de despensa confirmado este mes
      const mesActual = hoy.getMonth();
      const anioActual = hoy.getFullYear();
      const pagosEsteMes = u.pagos ? u.pagos.filter(p => {
        const fechaPago = new Date(p.fecha);
        return p.estado === 'confirmado' &&
               p.concepto === 'Despensa mensual' &&
               fechaPago.getMonth() === mesActual &&
               fechaPago.getFullYear() === anioActual;
      }) : [];

      // Si estamos después del día 10 y no ha pagado, congelar
      if (hoy.getDate() > 10 && pagosEsteMes.length === 0) {
        // Aviso 5 días antes (día 5)
        if (hoy.getDate() === 5) {
          await enviarMensaje(u.telefono,
            '⚠️ *AVISO IMPORTANTE*\n\n' +
            'Hola *' + u.nombre + '* 👋\n\n' +
            'No hemos recibido tu pago de despensa este mes.\n\n' +
            '📅 Si no registras tu pago antes del *día 10*, tu cuenta será congelada temporalmente.\n\n' +
            '💵 Despensa mensual: *$250 pesos*\n\n' +
            'Para pagar escribe *MENU* → opción *4*'
          );
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Congelar después del día 10
        if (hoy.getDate() > 10) {
          await Usuario.updateOne({ id: u.id }, { congelado: true, activo: false });

          // Notificar al usuario
          await enviarMensaje(u.telefono,
            '❄️ *CUENTA CONGELADA*\n\n' +
            'Hola *' + u.nombre + '*\n\n' +
            'Tu cuenta ha sido congelada por falta de pago de despensa este mes.\n\n' +
            'Para reactivarla:\n' +
            '1️⃣ Realiza tu pago de *$250 pesos*\n' +
            '2️⃣ Sube tu comprobante escribiendo *MENU* → opción *4*\n' +
            '3️⃣ El administrador validará y reactivará tu cuenta\n\n' +
            'Si tienes dudas contacta al administrador:\n' +
            'https://wa.me/525576683884'
          );

          // Notificar al patrocinador si tiene
          if (u.referidoPor) {
            const patrocinador = await Usuario.findOne({ id: u.referidoPor });
            if (patrocinador) {
              await enviarMensaje(patrocinador.telefono,
                '❄️ *AVISO — Referido congelado*\n\n' +
                'Tu referido *' + u.nombre + '* (' + u.id + ') fue congelado por falta de pago.\n\n' +
                'Puedes contactarlo para apoyarlo a regularizarse.'
              );
            }
          }

          console.log('❄️ Usuario congelado: ' + u.id + ' — ' + u.nombre);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    console.log('✅ Verificación de congelamientos completada');
  } catch (err) {
    console.error('❌ Error en congelamiento:', err.message);
  }
}

// Ejecutar verificación de congelamiento diario a las 8 AM hora Mexico (2 PM UTC)
function iniciarCongelamiento() {
  var ahora = new Date();
  var proximaEjecucion = new Date();
  proximaEjecucion.setUTCHours(14, 0, 0, 0);
  if (proximaEjecucion <= ahora) {
    proximaEjecucion.setDate(proximaEjecucion.getDate() + 1);
  }
  var tiempoEspera = proximaEjecucion - ahora;
  console.log('Próximo congelamiento en ' + Math.round(tiempoEspera/1000/60) + ' minutos');
  setTimeout(function() {
    verificarCongelamiento();
    setInterval(verificarCongelamiento, 24 * 60 * 60 * 1000);
  }, tiempoEspera);
}

// ============================================================
// LISTA MENSUAL DE DESPENSAS
// ============================================================
async function generarListaMensual() {
  try {
    console.log('Generando lista mensual...');
    const hoy = new Date();
    const mes = hoy.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
    const usuarios = await Usuario.find({ activo: true, congelado: false }).sort({ nivel: 1, fechaRegistro: 1 });

    if (usuarios.length === 0) {
      await enviarMensaje('5215585567250', '📋 Lista mensual: No hay usuarios activos.');
      return;
    }

    // Agrupar por nivel
    const porNivel = {};
    for (const u of usuarios) {
      const nv = u.nivel || 0;
      if (!porNivel[nv]) porNivel[nv] = [];
      porNivel[nv].push(u);
    }

    let lista = '📋 *LISTA MENSUAL DE DESPENSAS*\n';
    lista += '━━━━━━━━━━━━━━━━━━━━\n';
    lista += '📅 ' + mes.toUpperCase() + '\n';
    lista += '━━━━━━━━━━━━━━━━━━━━\n\n';

    for (const nv of Object.keys(porNivel).sort()) {
      const color = COLORES_NIVEL[nv] || 'VIOLETA';
      lista += '🎨 *Nivel ' + nv + ' — ' + color + '*\n';
      for (const u of porNivel[nv]) {
        if (USUARIOS_EXENTOS.includes(u.id)) continue;
        lista += '• ' + u.id + ' — ' + u.nombre + '\n';
      }
      lista += '\n';
    }

    lista += '━━━━━━━━━━━━━━━━━━━━\n';
    lista += '👥 Total activos: *' + usuarios.filter(u => !USUARIOS_EXENTOS.includes(u.id)).length + '*\n';
    lista += '_DespensaClub — Lista automática_';

    await enviarMensaje('5215585567250', lista);
    console.log('✅ Lista mensual enviada');
  } catch (err) {
    console.error('❌ Error generando lista mensual:', err.message);
  }
}

// ============================================================
// REPORTE MENSUAL AUTOMÁTICO
// ============================================================
async function enviarReporteMensual() {
  try {
    console.log('Generando reporte mensual...');
    const hoy = new Date();
    const mes = hoy.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
    const mesActual = hoy.getMonth();
    const anioActual = hoy.getFullYear();

    const todos = await Usuario.find({});
    const activos = todos.filter(u => u.activo && !u.congelado);
    const congelados = todos.filter(u => u.congelado);

    // Pagos del mes
    let ingresosMes = 0;
    let pagosConfirmadosMes = 0;
    for (const u of todos) {
      const pagos = u.pagos ? u.pagos.filter(p => {
        const fp = new Date(p.fecha);
        return p.estado === 'confirmado' &&
               fp.getMonth() === mesActual &&
               fp.getFullYear() === anioActual;
      }) : [];
      pagosConfirmadosMes += pagos.length;
      ingresosMes += pagos.reduce((s, p) => s + (p.monto || 0), 0);
    }

    // Consumos del mes
    let consumosMes = 0;
    for (const u of todos) {
      const cons = u.consumos ? u.consumos.filter(c => {
        const fc = new Date(c.fecha);
        return fc.getMonth() === mesActual && fc.getFullYear() === anioActual;
      }) : [];
      consumosMes += cons.length;
    }

    const reporte =
      '📊 *REPORTE MENSUAL DESPENSACLUB*\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '📅 ' + mes.toUpperCase() + '\n' +
      '━━━━━━━━━━━━━━━━━━━━\n\n' +
      '👥 *USUARIOS*\n' +
      '• Total registrados: *' + todos.length + '*\n' +
      '• Activos: *' + activos.length + '*\n' +
      '• Congelados: *' + congelados.length + '*\n\n' +
      '💰 *PAGOS DEL MES*\n' +
      '• Pagos confirmados: *' + pagosConfirmadosMes + '*\n' +
      '• Ingresos totales: *$' + ingresosMes + ' pesos*\n\n' +
      '📦 *CONSUMOS DEL MES*\n' +
      '• Despensas entregadas: *' + consumosMes + '*\n\n' +
      '━━━━━━━━━━━━━━━━━━━━\n' +
      '_DespensaClub — Reporte automático mensual_';

    await enviarMensaje('5215585567250', reporte);
    console.log('✅ Reporte mensual enviado');
  } catch (err) {
    console.error('❌ Error generando reporte mensual:', err.message);
  }
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

      // Enviar link de credencial digital al usuario
      await new Promise(r => setTimeout(r, 2000));
      await enviarMensaje(telefono,
        '🪪 *TU CREDENCIAL DIGITAL*\n\n' +
        'Accede a tu credencial aquí:\n' +
        'https://despensas-bot-production.up.railway.app/credencial/' + nuevoID + '\n\n' +
        '📱 Ábrela desde tu celular o computadora e imprímela.'
      );

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
      const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'No registrada';

      // Calcular estado de membresía
      const hoy = new Date();
      const vigenciaDate = u.vigencia ? new Date(u.vigencia) : null;
      const diasRestantes = vigenciaDate ? Math.ceil((vigenciaDate - hoy) / (1000 * 60 * 60 * 24)) : null;
      let estadoMembresia = '';
      if (!vigenciaDate) estadoMembresia = '⏳ Sin membresía activa';
      else if (diasRestantes < 0) estadoMembresia = '❌ Membresía vencida';
      else if (diasRestantes <= 30) estadoMembresia = '⚠️ Vence en ' + diasRestantes + ' días';
      else estadoMembresia = '✅ Activa (' + diasRestantes + ' días restantes)';

      // Último pago confirmado
      const pagosConfirmados = u.pagos ? u.pagos.filter(p => p.estado === 'confirmado') : [];
      const ultimoPago = pagosConfirmados.length > 0 ? pagosConfirmados[pagosConfirmados.length - 1] : null;
      const ultimoPagoStr = ultimoPago
        ? new Date(ultimoPago.fecha).toLocaleDateString('es-MX') + ' — $' + ultimoPago.monto + ' (' + ultimoPago.concepto + ')'
        : 'Sin pagos confirmados';

      // Pagos pendientes
      const pagosPendientes = u.pagos ? u.pagos.filter(p => p.estado === 'pendiente') : [];

      await enviarMensaje(telefono,
        '👤 *MI CUENTA*\n' +
        '━━━━━━━━━━━━━━━━━━━━\n' +
        '🪪 ID: *' + u.id + '*\n' +
        '👤 ' + u.nombre + '\n' +
        '🎨 Nivel: ' + (u.nivel || 0) + ' — ' + color + '\n' +
        '👥 Referidos: ' + u.referidos.length + '/4\n\n' +
        '📋 *MEMBRESÍA*\n' +
        estadoMembresia + '\n' +
        '📅 Vencimiento: ' + vigenciaStr + '\n\n' +
        '💰 *PAGOS*\n' +
        '✅ Último pago: ' + ultimoPagoStr + '\n' +
        (pagosPendientes.length > 0 ? '⏳ Tienes *' + pagosPendientes.length + '* pago(s) pendiente(s) de validar\n' : '') +
        '\n🔗 Tu credencial:\nhttps://despensas-bot-production.up.railway.app/credencial/' + u.id + '\n\n' +
        'Escribe *MENU* para volver.'
      );
      return;
    }

    // ── COMANDO MI CUENTA (disponible en cualquier momento)
    if (texto === 'MI CUENTA' || texto === 'MICUENTA') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta registrada.\n\nEscribe *MENU* para registrarte.');
        return;
      }
      sesiones[telefono] = { paso: 'menu', datos: {} };
      await procesarMensaje(telefono, '2');
      return;
    }

    // ── COMANDO MI PORTAL (login OTP para usuario)
    if (texto === 'MI PORTAL' || texto === 'MIPORTAL') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta registrada.\n\nEscribe *MENU* para registrarte.');
        return;
      }
      const codigo = generarOTP();
      otpSesiones[usuarioExistente.id] = { codigo: codigo, expira: Date.now() + 5 * 60 * 1000 };
      await enviarMensaje(telefono,
        '🔐 *ACCESO A TU PORTAL*\n\n' +
        'Tu código de acceso es:\n\n' +
        '*' + codigo + '*\n\n' +
        '⏱️ Válido por *5 minutos*\n\n' +
        '🌐 Ingresa aquí:\n' +
        'https://despensas-bot-production.up.railway.app/portal?id=' + usuarioExistente.id
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
      sesiones[telefono] = { paso: 'pedir_tipo_pago', datos: {} };
      await enviarMensaje(telefono,
        '💰 *REGISTRAR PAGO*\n\n' +
        '¿Qué concepto vas a pagar?\n\n' +
        '1️⃣ Membresía anual — *$50 pesos*\n' +
        '2️⃣ Despensa mensual — *$250 pesos*\n\n' +
        'Responde con *1* o *2*'
      );
      return;
    }

    if (sesion.paso === 'pedir_tipo_pago') {
      if (texto !== '1' && texto !== '2') {
        await enviarMensaje(telefono, '❌ Responde solo con *1* o *2*');
        return;
      }
      const concepto = texto === '1' ? 'Membresía anual' : 'Despensa mensual';
      const monto = texto === '1' ? 50 : 250;
      sesiones[telefono] = { paso: 'esperar_comprobante', datos: { concepto, monto } };
      await enviarMensaje(telefono,
        '📸 *SUBE TU COMPROBANTE*\n\n' +
        'Concepto: *' + concepto + '*\n' +
        'Monto: *$' + monto + ' pesos*\n\n' +
        'Ahora envía una *foto o captura* de tu comprobante de pago.\n\n' +
        '⚠️ Asegúrate que se vea claramente el monto y la referencia.'
      );
      return;
    }

    if (sesion.paso === 'esperar_comprobante') {
      const { concepto, monto } = sesion.datos;

      // Verificar que mandó imagen
      if (texto !== '__IMAGEN__') {
        await enviarMensaje(telefono, '📸 Por favor envía una *foto o imagen* de tu comprobante de pago.');
        return;
      }

      const fecha = new Date();

      await Usuario.updateOne(
        { telefono: telefono },
        { $push: { pagos: {
          concepto: concepto,
          monto: monto,
          fecha: fecha,
          estado: 'pendiente',
          comprobante: 'enviado_por_whatsapp'
        }}}
      );
      delete sesiones[telefono];

      await enviarMensaje(telefono,
        '✅ *COMPROBANTE RECIBIDO*\n\n' +
        'Concepto: *' + concepto + '*\n' +
        'Monto: *$' + monto + ' pesos*\n' +
        'Estado: ⏳ Pendiente de confirmación\n\n' +
        'El administrador validará tu pago en breve y recibirás confirmación.'
      );

      await enviarMensaje('5215585567250',
        '💰 *COMPROBANTE DE PAGO RECIBIDO*\n\n' +
        '👤 ' + usuarioExistente.nombre + '\n' +
        '🪪 ' + usuarioExistente.id + '\n' +
        '📱 +' + telLimpio + '\n' +
        '💵 Concepto: ' + concepto + '\n' +
        '💵 Monto: $' + monto + ' pesos\n' +
        '📅 ' + fecha.toLocaleDateString('es-MX') + '\n\n' +
        'Para confirmar escribe:\n*CONFIRMAR ' + usuarioExistente.id + '*\n\n' +
        'Para rechazar escribe:\n*RECHAZAR ' + usuarioExistente.id + '*'
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
      String(telefono).includes('5585567250') ||
      String(telLimpio).includes('5585567250') ||
      ADMIN_PHONE.includes(String(telLimpio).slice(-10))
    );

    if (esAdmin) {

      if (texto === 'REPORTE MENSUAL' || texto === 'REPORTEMENSUAL') {
        await enviarMensaje(telefono, '📊 Generando reporte mensual...');
        await enviarReporteMensual();
        await enviarMensaje(telefono, '✅ Reporte enviado al 5585567250.');
        return;
      }

      if (texto === 'LISTA MENSUAL' || texto === 'LISTAMENSUAL') {
        await enviarMensaje(telefono, '📋 Generando lista mensual...');
        await generarListaMensual();
        await enviarMensaje(telefono, '✅ Lista enviada al 5585567250.');
        return;
      }

      if (texto === 'VERIFICAR') {
        await enviarMensaje(telefono, '❄️ Verificando congelamientos...');
        await verificarCongelamiento();
        await enviarMensaje(telefono, '✅ Verificación completada.');
        return;
      }

      if (texto === 'RECORDATORIOS') {
        await enviarMensaje(telefono, '📅 Enviando recordatorios...');
        await enviarRecordatorios();
        await enviarMensaje(telefono, '✅ Recordatorios enviados.');
        return;
      }

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
        const idU = texto.replace('CONFIRMAR ', '').trim().toUpperCase();
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idU); return; }
        const pagoIdx = userU.pagos.findLastIndex(function(p) { return p.estado === 'pendiente'; });
        if (pagoIdx === -1) { await enviarMensaje(telefono, '❌ No hay pagos pendientes para ' + idU); return; }
        userU.pagos[pagoIdx].estado = 'confirmado';

        // Reactivar si estaba congelado
        const estabaCongelado = userU.congelado || !userU.activo;
        userU.congelado = false;
        userU.activo = true;

        // Si es membresía, actualizar vigencia
        if (userU.pagos[pagoIdx].concepto === 'Membresía anual') {
          const nuevaVigencia = new Date();
          nuevaVigencia.setFullYear(nuevaVigencia.getFullYear() + 1);
          userU.vigencia = nuevaVigencia;
        }

        await userU.save();
        const pago = userU.pagos[pagoIdx];

        await enviarMensaje(telefono,
          '✅ *PAGO CONFIRMADO*\n\n' +
          '👤 ' + userU.nombre + '\n' +
          '🪪 ' + idU + '\n' +
          '💵 ' + pago.concepto + ' — $' + pago.monto + ' pesos' +
          (estabaCongelado ? '\n\n❄️➡️✅ Cuenta reactivada automáticamente.' : '')
        );

        await enviarMensaje(userU.telefono,
          '✅ *TU PAGO FUE CONFIRMADO*\n\n' +
          'Hola *' + userU.nombre + '*\n\n' +
          '💵 Concepto: ' + pago.concepto + '\n' +
          '💵 Monto: $' + pago.monto + ' pesos\n' +
          '📅 Fecha: ' + new Date().toLocaleDateString('es-MX') +
          (pago.concepto === 'Membresía anual' ? '\n⏳ Vigencia: ' + new Date(userU.vigencia).toLocaleDateString('es-MX') : '') +
          (estabaCongelado ? '\n\n🎉 *Tu cuenta ha sido reactivada.*\nYa puedes disfrutar de todos los beneficios.' : '') +
          '\n\n¡Gracias por tu pago! 🛒'
        );

        // Notificar al patrocinador si se reactivó
        if (estabaCongelado && userU.referidoPor) {
          const patrocinador = await Usuario.findOne({ id: userU.referidoPor });
          if (patrocinador) {
            await enviarMensaje(patrocinador.telefono,
              '✅ *Tu referido se reactivó*\n\n' +
              '*' + userU.nombre + '* (' + userU.id + ') regularizó su pago y su cuenta está activa nuevamente.'
            );
          }
        }
        return;
      }

      if (texto.startsWith('RECHAZAR ')) {
        const idU = texto.replace('RECHAZAR ', '').trim().toUpperCase();
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idU); return; }
        const pagoIdx = userU.pagos.findLastIndex(function(p) { return p.estado === 'pendiente'; });
        if (pagoIdx === -1) { await enviarMensaje(telefono, '❌ No hay pagos pendientes para ' + idU); return; }
        userU.pagos[pagoIdx].estado = 'rechazado';
        await userU.save();
        await enviarMensaje(telefono,
          '❌ *PAGO RECHAZADO*\n\n' +
          '👤 ' + userU.nombre + '\n' +
          '🪪 ' + idU + '\n' +
          'El usuario fue notificado.'
        );
        await enviarMensaje(userU.telefono,
          '❌ *TU COMPROBANTE FUE RECHAZADO*\n\n' +
          'Hola *' + userU.nombre + '*\n\n' +
          'Tu comprobante de pago no pudo ser validado.\n\n' +
          'Por favor verifica y vuelve a enviarlo o contacta al administrador:\n' +
          'https://wa.me/525576683884'
        );
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

      // Detectar si es imagen (comprobante)
      if (!mensaje && (msgContent.imageMessage || msgContent.documentMessage)) {
        mensaje = '__IMAGEN__';
      }

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

app.get('/credencial/:id', async function(req, res) {
  try {
    const usuario = await Usuario.findOne({ id: req.params.id.toUpperCase() });
    if (!usuario) return res.status(404).send('Credencial no encontrada.');

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

    const color = COLORES_HEX[usuario.nivel || 0] || COLORES_HEX[0];
    const fechaReg = new Date(usuario.fechaRegistro).toLocaleDateString('es-MX');
    const vigencia = usuario.vigencia ? new Date(usuario.vigencia).toLocaleDateString('es-MX') : 'N/A';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${usuario.id}&color=${color.bg.replace('#','')}`;

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Credencial — ${usuario.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f0f0f0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; font-family: 'Arial', sans-serif; padding: 20px; }
    .credencial {
      width: 340px;
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,0.25);
      background: #fff;
    }
    .header {
      background: ${color.bg};
      color: ${color.text};
      padding: 18px 20px 14px;
      text-align: center;
    }
    .header-logo { font-size: 28px; margin-bottom: 2px; }
    .header-title { font-size: 16px; font-weight: bold; letter-spacing: 1px; }
    .header-sub { font-size: 11px; opacity: 0.85; margin-top: 2px; }
    .nivel-badge {
      background: rgba(255,255,255,0.25);
      border-radius: 20px;
      padding: 3px 14px;
      font-size: 11px;
      font-weight: bold;
      display: inline-block;
      margin-top: 8px;
      letter-spacing: 2px;
    }
    .body { padding: 18px 20px; }
    .nombre { font-size: 17px; font-weight: bold; color: #222; text-align: center; margin-bottom: 4px; }
    .id { font-size: 13px; color: #666; text-align: center; margin-bottom: 14px; letter-spacing: 1px; }
    .divider { border: none; border-top: 1px solid #eee; margin: 10px 0; }
    .fila { display: flex; justify-content: space-between; margin-bottom: 7px; }
    .fila-label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .fila-valor { font-size: 12px; color: #333; font-weight: bold; }
    .qr-section { display: flex; justify-content: center; margin: 14px 0 8px; }
    .qr-section img { border-radius: 8px; border: 3px solid ${color.bg}; }
    .footer {
      background: ${color.bg};
      color: ${color.text};
      text-align: center;
      padding: 10px;
      font-size: 10px;
      opacity: 0.9;
    }
    .btn-imprimir {
      margin-top: 20px;
      padding: 12px 30px;
      background: ${color.bg};
      color: ${color.text};
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: bold;
      cursor: pointer;
    }
    @media print {
      body { background: white; }
      .btn-imprimir { display: none; }
    }
  </style>
</head>
<body>
  <div class="credencial">
    <div class="header">
      <div class="header-logo">🛒</div>
      <div class="header-title">DESPENSACLUB FAMILIAR</div>
      <div class="header-sub">Red de Consumo Inteligente</div>
      <div class="nivel-badge">NIVEL ${usuario.nivel || 0} — ${color.nombre}</div>
    </div>
    <div class="body">
      <div class="nombre">${usuario.nombre.toUpperCase()}</div>
      <div class="id">${usuario.id}</div>
      <hr class="divider">
      <div class="fila">
        <span class="fila-label">📅 Registro</span>
        <span class="fila-valor">${fechaReg}</span>
      </div>
      <div class="fila">
        <span class="fila-label">⏳ Vigencia</span>
        <span class="fila-valor">${vigencia}</span>
      </div>
      <div class="fila">
        <span class="fila-label">👥 Referidos</span>
        <span class="fila-valor">${usuario.referidos ? usuario.referidos.length : 0}/4</span>
      </div>
      <div class="fila">
        <span class="fila-label">✅ Estado</span>
        <span class="fila-valor">${usuario.activo ? 'Activo' : 'Inactivo'}</span>
      </div>
      <div class="qr-section">
        <img src="${qrUrl}" width="120" height="120" alt="QR">
      </div>
    </div>
    <div class="footer">
      Escanea el QR para verificar esta credencial • DespensaClub 2026
    </div>
  </div>
  <button class="btn-imprimir" onclick="window.print()">🖨️ Imprimir credencial</button>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/usuarios', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const { filtro, nivel, estado } = req.query;
    let query = {};
    if (estado === 'activo') query = { activo: true, congelado: false };
    else if (estado === 'congelado') query = { congelado: true };
    else if (estado === 'inactivo') query = { activo: false, congelado: false };
    if (nivel !== undefined && nivel !== '') query.nivel = parseInt(nivel);

    const usuarios = await Usuario.find(query).sort({ nivel: 1, fechaRegistro: 1 }).lean();

    const COLORES_HEX = {
      0: '#7B2FBE', 1: '#F5A623', 2: '#2196F3', 3: '#FF6B2B',
      4: '#E91E8C', 5: '#4CAF50', 6: '#FFC107', 7: '#00BCD4',
      8: '#1B5E20', 9: '#9E9E9E'
    };

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Usuarios — DespensaClub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 16px; }
    h1 { color: #25D366; font-size: 18px; margin-bottom: 4px; text-align: center; }
    .sub { text-align: center; color: #aaa; font-size: 12px; margin-bottom: 16px; }
    .filtros { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; justify-content: center; }
    .filtros select { padding: 8px 12px; border-radius: 8px; border: none; background: #16213e; color: #fff; font-size: 13px; }
    .filtros a { padding: 8px 16px; border-radius: 8px; background: #25D366; color: #000; text-decoration: none; font-size: 13px; font-weight: bold; }
    .total { text-align: center; color: #aaa; font-size: 12px; margin-bottom: 12px; }
    .usuario { background: #16213e; border-radius: 12px; padding: 14px; margin-bottom: 10px; }
    .usuario-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .nivel-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
    .nombre { font-weight: bold; font-size: 14px; }
    .id { font-size: 11px; color: #aaa; }
    .datos { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; }
    .dato { color: #aaa; }
    .dato span { color: #fff; }
    .badge { border-radius: 20px; padding: 2px 8px; font-size: 10px; font-weight: bold; margin-left: auto; }
    .badge-activo { background: #1b5e20; color: #fff; }
    .badge-congelado { background: #0d47a1; color: #fff; }
    .badge-inactivo { background: #b71c1c; color: #fff; }
    .pago-pendiente { color: #FFC107; font-size: 11px; margin-top: 6px; }
    .btn-ver { display: inline-block; margin-top: 8px; padding: 5px 14px; background: #0f3460; border-radius: 6px; color: #fff; text-decoration: none; font-size: 11px; }
    .vacio { text-align: center; color: #666; margin-top: 40px; }
    .back { display: block; text-align: center; margin-top: 16px; color: #25D366; text-decoration: none; font-size: 13px; }
  </style>
</head>
<body>
  <h1>👥 Gestión de Usuarios</h1>
  <p class="sub">DespensaClub Familiar</p>

  <form method="GET">
    <input type="hidden" name="key" value="despensas2026">
    <div class="filtros">
      <select name="estado" onchange="this.form.submit()">
        <option value="">Todos los estados</option>
        <option value="activo" ${estado === 'activo' ? 'selected' : ''}>✅ Activos</option>
        <option value="congelado" ${estado === 'congelado' ? 'selected' : ''}>❄️ Congelados</option>
        <option value="inactivo" ${estado === 'inactivo' ? 'selected' : ''}>❌ Inactivos</option>
      </select>
      <select name="nivel" onchange="this.form.submit()">
        <option value="">Todos los niveles</option>
        ${[0,1,2,3,4,5,6,7,8,9].map(n => `<option value="${n}" ${nivel == n ? 'selected' : ''}>Nivel ${n}</option>`).join('')}
      </select>
    </div>
  </form>

  <p class="total">${usuarios.length} usuario(s) encontrado(s)</p>

  ${usuarios.length === 0 ? '<div class="vacio">😴 Sin resultados</div>' : usuarios.map(u => {
    const color = COLORES_HEX[u.nivel || 0] || '#7B2FBE';
    const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'N/A';
    const pagosPend = u.pagos ? u.pagos.filter(p => p.estado === 'pendiente').length : 0;
    const ultimoPago = u.pagos ? u.pagos.filter(p => p.estado === 'confirmado').pop() : null;
    return `
    <div class="usuario">
      <div class="usuario-header">
        <div class="nivel-dot" style="background:${color}"></div>
        <div>
          <div class="nombre">${u.nombre}</div>
          <div class="id">${u.id}</div>
        </div>
        <span class="badge ${u.congelado ? 'badge-congelado' : u.activo ? 'badge-activo' : 'badge-inactivo'}">
          ${u.congelado ? '❄️ Congelado' : u.activo ? '✅ Activo' : '❌ Inactivo'}
        </span>
      </div>
      <div class="datos">
        <div class="dato">📱 Tel: <span>${u.telefonoLimpio || 'N/A'}</span></div>
        <div class="dato">🎨 Nivel: <span>${u.nivel || 0}</span></div>
        <div class="dato">👥 Referidos: <span>${u.referidos ? u.referidos.length : 0}/4</span></div>
        <div class="dato">⏳ Vigencia: <span>${vigenciaStr}</span></div>
        <div class="dato">📅 Registro: <span>${new Date(u.fechaRegistro).toLocaleDateString('es-MX')}</span></div>
        <div class="dato">💰 Último pago: <span>${ultimoPago ? '$' + ultimoPago.monto : 'Sin pagos'}</span></div>
      </div>
      ${pagosPend > 0 ? `<div class="pago-pendiente">⏳ ${pagosPend} pago(s) pendiente(s) de validar</div>` : ''}
      <a class="btn-ver" href="/admin/usuario/${u.id}?key=despensas2026">Ver expediente completo →</a>
    </div>`;
  }).join('')}

  <a class="back" href="/admin/dashboard?key=despensas2026">← Volver al Dashboard</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Vista detallada de usuario individual
app.get('/admin/usuario/:id', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const u = await Usuario.findOne({ id: req.params.id.toUpperCase() }).lean();
    if (!u) return res.status(404).send('Usuario no encontrado');

    const COLORES_HEX = {
      0: '#7B2FBE', 1: '#F5A623', 2: '#2196F3', 3: '#FF6B2B',
      4: '#E91E8C', 5: '#4CAF50', 6: '#FFC107', 7: '#00BCD4',
      8: '#1B5E20', 9: '#9E9E9E'
    };
    const color = COLORES_HEX[u.nivel || 0] || '#7B2FBE';
    const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'N/A';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${u.id} — Expediente</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 16px; }
    .header { background: ${color}; border-radius: 12px; padding: 16px; text-align: center; margin-bottom: 16px; }
    .nombre { font-size: 18px; font-weight: bold; }
    .id { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    .seccion { background: #16213e; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    .seccion h3 { font-size: 13px; color: #25D366; margin-bottom: 10px; }
    .fila { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #0f3460; font-size: 12px; }
    .fila:last-child { border-bottom: none; }
    .fila-label { color: #aaa; }
    .pago-item { padding: 8px 0; border-bottom: 1px solid #0f3460; font-size: 12px; }
    .pago-item:last-child { border-bottom: none; }
    .estado-conf { color: #25D366; }
    .estado-pend { color: #FFC107; }
    .estado-rech { color: #f44336; }
    .vacio { color: #666; font-size: 12px; }
    .acciones { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .btn { padding: 10px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: bold; text-decoration: none; display: block; }
    .btn-confirmar { background: #1b5e20; color: #fff; }
    .btn-desactivar { background: #b71c1c; color: #fff; }
    .btn-activar { background: #0d47a1; color: #fff; }
    .btn-cred { background: #7B2FBE; color: #fff; }
    .back { display: block; text-align: center; margin-top: 16px; color: #25D366; text-decoration: none; font-size: 13px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="nombre">${u.nombre.toUpperCase()}</div>
    <div class="id">${u.id} — Nivel ${u.nivel || 0}</div>
    <div style="margin-top:6px;font-size:12px">${u.congelado ? '❄️ Congelado' : u.activo ? '✅ Activo' : '❌ Inactivo'}</div>
  </div>

  <div class="acciones">
    <a class="btn btn-cred" href="/credencial/${u.id}" target="_blank">🪪 Ver credencial</a>
    ${u.activo ? `<a class="btn btn-desactivar" href="/admin/accion/${u.id}/desactivar?key=despensas2026">❌ Desactivar</a>` :
                 `<a class="btn btn-activar" href="/admin/accion/${u.id}/activar?key=despensas2026">✅ Activar</a>`}
  </div>

  <div class="seccion">
    <h3>📋 Datos personales</h3>
    <div class="fila"><span class="fila-label">📱 Teléfono</span><span>${u.telefonoLimpio || 'N/A'}</span></div>
    <div class="fila"><span class="fila-label">📅 Registro</span><span>${new Date(u.fechaRegistro).toLocaleDateString('es-MX')}</span></div>
    <div class="fila"><span class="fila-label">⏳ Vigencia</span><span>${vigenciaStr}</span></div>
    <div class="fila"><span class="fila-label">👥 Referido por</span><span>${u.referidoPor || 'Directo'}</span></div>
    <div class="fila"><span class="fila-label">👥 Referidos</span><span>${u.referidos ? u.referidos.join(', ') || 'Ninguno' : 'Ninguno'}</span></div>
  </div>

  <div class="seccion">
    <h3>💰 Historial de pagos</h3>
    ${u.pagos && u.pagos.length > 0 ? [...u.pagos].reverse().map(p => `
      <div class="pago-item">
        <div class="${p.estado === 'confirmado' ? 'estado-conf' : p.estado === 'pendiente' ? 'estado-pend' : 'estado-rech'}">
          ${p.estado === 'confirmado' ? '✅' : p.estado === 'pendiente' ? '⏳' : '❌'} ${p.estado.toUpperCase()}
        </div>
        <div>${p.concepto || 'Pago'} — $${p.monto} pesos</div>
        <div style="color:#aaa">${new Date(p.fecha).toLocaleDateString('es-MX')}</div>
      </div>
    `).join('') : '<div class="vacio">Sin pagos registrados</div>'}
  </div>

  <div class="seccion">
    <h3>📦 Historial de consumos</h3>
    ${u.consumos && u.consumos.length > 0 ? [...u.consumos].reverse().map(c => `
      <div class="pago-item">
        <div>📦 ${c.descripcion || 'Despensa'}</div>
        <div style="color:#aaa">${new Date(c.fecha).toLocaleDateString('es-MX')}</div>
      </div>
    `).join('') : '<div class="vacio">Sin consumos registrados</div>'}
  </div>

  <a class="back" href="/admin/usuarios?key=despensas2026">← Volver a lista</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Acciones rápidas sobre usuario
app.get('/admin/accion/:id/:accion', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const { id, accion } = req.params;
    const u = await Usuario.findOne({ id: id.toUpperCase() });
    if (!u) return res.status(404).send('Usuario no encontrado');

    if (accion === 'activar') {
      await Usuario.updateOne({ id: u.id }, { activo: true, congelado: false });
      await enviarMensaje(u.telefono, '✅ *Tu cuenta ha sido reactivada.*\n\nYa puedes usar todos los servicios de DespensaClub. 🛒');
    } else if (accion === 'desactivar') {
      await Usuario.updateOne({ id: u.id }, { activo: false });
      await enviarMensaje(u.telefono, '⚠️ Tu cuenta ha sido suspendida.\nContacta al administrador: https://wa.me/525576683884');
    }

    res.redirect('/admin/usuario/' + u.id + '?key=despensas2026');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/dashboard', async function(req, res) {
  if (req.query.key !== 'despensas2026') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const hoy = new Date();
    const mesActual = hoy.getMonth();
    const anioActual = hoy.getFullYear();
    const todos = await Usuario.find({}).lean();

    const totalUsuarios = todos.length;
    const activos = todos.filter(u => u.activo && !u.congelado).length;
    const congelados = todos.filter(u => u.congelado).length;
    const inactivos = todos.filter(u => !u.activo && !u.congelado).length;

    // Pagos del mes
    let pagosPendientes = 0;
    let pagosConfirmados = 0;
    let ingresosMes = 0;
    for (const u of todos) {
      if (u.pagos) {
        pagosPendientes += u.pagos.filter(p => p.estado === 'pendiente').length;
        const conf = u.pagos.filter(p => {
          const fp = new Date(p.fecha);
          return p.estado === 'confirmado' &&
                 fp.getMonth() === mesActual &&
                 fp.getFullYear() === anioActual;
        });
        pagosConfirmados += conf.length;
        ingresosMes += conf.reduce((s, p) => s + (p.monto || 0), 0);
      }
    }

    // Consumos del mes
    let consumosMes = 0;
    for (const u of todos) {
      if (u.consumos) {
        consumosMes += u.consumos.filter(c => {
          const fc = new Date(c.fecha);
          return fc.getMonth() === mesActual && fc.getFullYear() === anioActual;
        }).length;
      }
    }

    // Últimos 5 registros
    const ultimos = [...todos].sort((a, b) => new Date(b.fechaRegistro) - new Date(a.fechaRegistro)).slice(0, 5);

    // Membresías por vencer en 30 días
    const porVencer = todos.filter(u => {
      if (!u.vigencia) return false;
      const dias = Math.ceil((new Date(u.vigencia) - hoy) / (1000 * 60 * 60 * 24));
      return dias > 0 && dias <= 30;
    }).length;

    const mes = hoy.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard — DespensaClub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 16px; min-height: 100vh; }
    h1 { text-align: center; color: #25D366; font-size: 20px; margin-bottom: 4px; }
    .sub { text-align: center; color: #aaa; font-size: 12px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; }
    .card { background: #16213e; border-radius: 12px; padding: 16px; text-align: center; }
    .card-num { font-size: 32px; font-weight: bold; }
    .card-label { font-size: 11px; color: #aaa; margin-top: 4px; }
    .card.verde .card-num { color: #25D366; }
    .card.amarillo .card-num { color: #FFC107; }
    .card.rojo .card-num { color: #f44336; }
    .card.azul .card-num { color: #2196F3; }
    .card.morado .card-num { color: #9C27B0; }
    .card.naranja .card-num { color: #FF6B2B; }
    .seccion { background: #16213e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .seccion h3 { font-size: 14px; color: #25D366; margin-bottom: 12px; }
    .usuario-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #0f3460; font-size: 12px; }
    .usuario-row:last-child { border-bottom: none; }
    .badge { border-radius: 20px; padding: 2px 8px; font-size: 10px; font-weight: bold; }
    .badge-activo { background: #1b5e20; color: #fff; }
    .badge-congelado { background: #0d47a1; color: #fff; }
    .badge-inactivo { background: #b71c1c; color: #fff; }
    .alerta { background: #f44336; border-radius: 8px; padding: 10px; margin-bottom: 8px; font-size: 12px; }
    .links { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 16px; }
    .btn { display: block; padding: 10px; background: #0f3460; border-radius: 8px; text-align: center; color: #fff; text-decoration: none; font-size: 12px; }
    .btn:hover { background: #25D366; color: #000; }
    .refresh { display: block; text-align: center; margin-top: 16px; color: #25D366; font-size: 13px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>🛒 DespensaClub Familiar</h1>
  <p class="sub">Dashboard — ${mes.toUpperCase()}</p>

  <div class="grid">
    <div class="card verde">
      <div class="card-num">${totalUsuarios}</div>
      <div class="card-label">👥 Total usuarios</div>
    </div>
    <div class="card verde">
      <div class="card-num">${activos}</div>
      <div class="card-label">✅ Activos</div>
    </div>
    <div class="card azul">
      <div class="card-num">${congelados}</div>
      <div class="card-label">❄️ Congelados</div>
    </div>
    <div class="card rojo">
      <div class="card-num">${inactivos}</div>
      <div class="card-label">❌ Inactivos</div>
    </div>
    <div class="card amarillo">
      <div class="card-num">${pagosPendientes}</div>
      <div class="card-label">⏳ Pagos pendientes</div>
    </div>
    <div class="card verde">
      <div class="card-num">$${ingresosMes}</div>
      <div class="card-label">💰 Ingresos del mes</div>
    </div>
    <div class="card morado">
      <div class="card-num">${pagosConfirmados}</div>
      <div class="card-label">✅ Pagos confirmados</div>
    </div>
    <div class="card naranja">
      <div class="card-num">${consumosMes}</div>
      <div class="card-label">📦 Despensas entregadas</div>
    </div>
  </div>

  ${pagosPendientes > 0 ? `<div class="alerta">⚠️ Tienes <strong>${pagosPendientes}</strong> pago(s) pendiente(s) de validar.</div>` : ''}
  ${porVencer > 0 ? `<div class="alerta" style="background:#e65100">⚠️ <strong>${porVencer}</strong> membresía(s) vencen en menos de 30 días.</div>` : ''}

  <div class="seccion">
    <h3>🆕 Últimos registros</h3>
    ${ultimos.map(u => `
      <div class="usuario-row">
        <div>
          <div style="font-weight:bold">${u.nombre}</div>
          <div style="color:#aaa">${u.id}</div>
        </div>
        <span class="badge ${u.congelado ? 'badge-congelado' : u.activo ? 'badge-activo' : 'badge-inactivo'}">
          ${u.congelado ? '❄️ Congelado' : u.activo ? '✅ Activo' : '❌ Inactivo'}
        </span>
      </div>
    `).join('')}
  </div>

  <div class="links">
    <a class="btn" href="/admin/dashboard?key=despensas2026">📊 Dashboard</a>
    <a class="btn" href="/admin/usuarios?key=despensas2026">👥 Usuarios</a>
    <a class="btn" href="/admin/arbol?key=despensas2026">🌳 Árbol</a>
    <a class="btn" href="/admin/lista?key=despensas2026">📋 Lista</a>
    <a class="btn" href="/admin/respaldo?key=despensas2026">📦 Respaldo</a>
    <a class="btn" href="/admin/login">🔐 Panel</a>
  </div>

  <span class="refresh" onclick="location.reload()">🔄 Actualizar</span>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
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

app.get('/portal', async function(req, res) {
  const { id, otp } = req.query;
  if (!id) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center;background:#1a1a2e;color:#fff;padding:20px">
        <h2>🛒 Portal DespensaClub</h2>
        <p>Manda <b>MI PORTAL</b> por WhatsApp al bot para recibir tu enlace de acceso.</p>
      </body></html>
    `);
  }

  const idU = id.toUpperCase();

  if (!otp) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center;background:#1a1a2e;color:#fff;padding:20px">
        <h2>🔐 Portal — ${idU}</h2>
        <p style="color:#aaa;font-size:13px">Ingresa el código de 6 dígitos que recibiste por WhatsApp</p>
        <form method="GET">
          <input type="hidden" name="id" value="${idU}">
          <input name="otp" placeholder="000000" maxlength="6"
            style="padding:12px;font-size:20px;width:160px;text-align:center;letter-spacing:6px;border-radius:8px;border:none;margin-top:16px">
          <br><br>
          <button type="submit" style="padding:12px 30px;background:#25D366;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer">
            Entrar
          </button>
        </form>
      </body></html>
    `);
  }

  if (!otpValido(idU, otp)) {
    return res.send(`
      <html><body style="font-family:sans-serif;max-width:400px;margin:100px auto;text-align:center;background:#1a1a2e;color:#fff;padding:20px">
        <h2>❌ Código incorrecto o expirado</h2>
        <p style="color:#aaa">Manda <b>MI PORTAL</b> nuevamente por WhatsApp.</p>
        <a href="/portal?id=${idU}" style="color:#25D366">Intentar de nuevo</a>
      </body></html>
    `);
  }

  try {
    const u = await Usuario.findOne({ id: idU }).lean();
    if (!u) return res.status(404).send('Usuario no encontrado');

    const COLORES_HEX = {
      0: '#7B2FBE', 1: '#F5A623', 2: '#2196F3', 3: '#FF6B2B',
      4: '#E91E8C', 5: '#4CAF50', 6: '#FFC107', 7: '#00BCD4',
      8: '#1B5E20', 9: '#9E9E9E'
    };
    const COLORES_NOMBRE = {
      0: 'VIOLETA', 1: 'DORADO', 2: 'AZUL', 3: 'NARANJA', 4: 'ROSA',
      5: 'VERDE', 6: 'AMARILLO', 7: 'TURQUESA', 8: 'VERDE BANDERA', 9: 'GRIS'
    };
    const color = COLORES_HEX[u.nivel || 0] || '#7B2FBE';
    const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'N/A';

    // Buscar nombres de referidos
    const referidosInfo = u.referidos && u.referidos.length > 0
      ? await Usuario.find({ id: { $in: u.referidos } }, 'id nombre activo').lean()
      : [];

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mi Portal — ${u.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 16px; }
    .header { background: ${color}; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 16px; }
    .nombre { font-size: 18px; font-weight: bold; }
    .id { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    .nivel-badge { background: rgba(255,255,255,0.25); border-radius: 20px; padding: 4px 14px; font-size: 11px; font-weight: bold; display: inline-block; margin-top: 8px; }
    .seccion { background: #16213e; border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    .seccion h3 { font-size: 13px; color: #25D366; margin-bottom: 10px; }
    .fila { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #0f3460; font-size: 12px; }
    .fila:last-child { border-bottom: none; }
    .fila-label { color: #aaa; }
    .item { padding: 8px 0; border-bottom: 1px solid #0f3460; font-size: 12px; }
    .item:last-child { border-bottom: none; }
    .estado-conf { color: #25D366; }
    .estado-pend { color: #FFC107; }
    .estado-rech { color: #f44336; }
    .vacio { color: #666; font-size: 12px; }
    .btn-cred { display: block; text-align: center; padding: 12px; background: ${color}; color: #fff; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 14px; margin-bottom: 16px; }
    .ref-activo { color: #25D366; }
    .ref-inactivo { color: #f44336; }
  </style>
</head>
<body>
  <div class="header">
    <div class="nombre">${u.nombre.toUpperCase()}</div>
    <div class="id">${u.id}</div>
    <div class="nivel-badge">NIVEL ${u.nivel || 0} — ${COLORES_NOMBRE[u.nivel || 0]}</div>
  </div>

  <a class="btn-cred" href="/credencial/${u.id}" target="_blank">🪪 Ver mi credencial digital</a>

  <div class="seccion">
    <h3>📋 Mi información</h3>
    <div class="fila"><span class="fila-label">Estado</span><span>${u.congelado ? '❄️ Congelado' : u.activo ? '✅ Activo' : '❌ Inactivo'}</span></div>
    <div class="fila"><span class="fila-label">📅 Registro</span><span>${new Date(u.fechaRegistro).toLocaleDateString('es-MX')}</span></div>
    <div class="fila"><span class="fila-label">⏳ Vigencia</span><span>${vigenciaStr}</span></div>
    <div class="fila"><span class="fila-label">👥 Referido por</span><span>${u.referidoPor || 'Directo'}</span></div>
  </div>

  <div class="seccion">
    <h3>👥 Mis referidos (${referidosInfo.length}/4)</h3>
    ${referidosInfo.length > 0 ? referidosInfo.map(r => `
      <div class="item">
        <span class="${r.activo ? 'ref-activo' : 'ref-inactivo'}">${r.activo ? '✅' : '❌'}</span>
        ${r.nombre} — ${r.id}
      </div>
    `).join('') : '<div class="vacio">Aún no tienes referidos. ¡Invita a tus familiares y amigos!</div>'}
  </div>

  <div class="seccion">
    <h3>💰 Historial de pagos</h3>
    ${u.pagos && u.pagos.length > 0 ? [...u.pagos].reverse().map(p => `
      <div class="item">
        <div class="${p.estado === 'confirmado' ? 'estado-conf' : p.estado === 'pendiente' ? 'estado-pend' : 'estado-rech'}">
          ${p.estado === 'confirmado' ? '✅' : p.estado === 'pendiente' ? '⏳' : '❌'} ${p.estado.toUpperCase()}
        </div>
        <div>${p.concepto || 'Pago'} — $${p.monto} pesos</div>
        <div style="color:#aaa">${new Date(p.fecha).toLocaleDateString('es-MX')}</div>
      </div>
    `).join('') : '<div class="vacio">Sin pagos registrados</div>'}
  </div>

  <div class="seccion">
    <h3>📦 Historial de consumos</h3>
    ${u.consumos && u.consumos.length > 0 ? [...u.consumos].reverse().map(c => `
      <div class="item">
        <div>📦 ${c.descripcion || 'Despensa'}</div>
        <div style="color:#aaa">${new Date(c.fecha).toLocaleDateString('es-MX')}</div>
      </div>
    `).join('') : '<div class="vacio">Sin consumos registrados</div>'}
  </div>
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
        <p><a href="/admin/dashboard?key=despensas2026">📊 Dashboard</a></p>
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
  iniciarRespaldoDiario();
  iniciarRecordatorios();
  iniciarCongelamiento();
});
