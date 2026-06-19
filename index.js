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
  comisiones: [{
    monto: Number,
    deUsuario: String,
    deNombre: String,
    fecha: Date,
    pagada: { type: Boolean, default: false }
  }],
  ineUrl: String,
  ineFecha: Date,
  notasAdmin: String,
  activo: { type: Boolean, default: true },
  congelado: { type: Boolean, default: false },
  archivado: { type: Boolean, default: false },
  fechaArchivado: Date
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

// ============================================================
// PRECIOS Y COMISIONES (configurables)
// ============================================================
const CONFIG_PRECIOS = {
  membresia: 50,
  despensa: 250,
  comisionReferido: 20
};

// QR de cobro CoDi (Banamex) — monto abierto, sin costo ni comisiones
const QR_CODI_URL = 'https://github.com/Javiergit-prog/despensas-bot/blob/main/QR%20Banamex.jpeg?raw=true';

const COLORES_NIVEL = {
  0: 'VIOLETA',      1: 'DORADO',       2: 'AZUL',
  3: 'NARANJA',      4: 'ROSA',         5: 'VERDE',
  6: 'AMARILLO',     7: 'TURQUESA',     8: 'VERDE BANDERA', 9: 'GRIS',
  10: 'ROJO',        11: 'CELESTE',     12: 'MAGENTA',
  13: 'LIMA',        14: 'CORAL',       15: 'ÍNDIGO',
  16: 'MENTA',       17: 'BRONCE',      18: 'LAVANDA',      19: 'ESMERALDA'
};

// ============================================================
// FUNCIONES DE BASE DE DATOS (MongoDB)
// ============================================================
function generarID(contador) {
  return 'DESP-' + String(contador).padStart(6, '0');
}

// ============================================================
// ASIGNACIÓN INTELIGENTE DE POSICIONES
// ============================================================
// Busca un lugar disponible (menos de 4 referidos) balanceado por niveles:
// recorre nivel por nivel desde la raíz hasta encontrar el primer hueco.
// ============================================================
// LÍMITE DE REFERIDOS — caso especial para el usuario raíz
// DESP-000110 (la raíz del árbol) solo puede tener 1 referido directo,
// ya que no tiene patrocinador propio que reciba el "excedente".
// Todos los demás usuarios mantienen el límite normal de 4.
// ============================================================
function limiteReferidos(idUsuario) {
  return idUsuario === 'DESP-000110' ? 1 : 4;
}

// ============================================================
// SISTEMA "2-UP SPLIT" — quién recibe la comisión de cada usuario
// ============================================================
// Para cualquier usuario, su comisión mensual de despensa NO siempre
// va a quien lo invitó directamente. Depende de su POSICIÓN DE REGISTRO
// (1°, 2°, 3° o 4°) entre los referidos de su patrocinador:
//
//   Posición 1 o 2  → la comisión sube al patrocinador DE SU PATROCINADOR
//                      (el "padre financiero", un nivel más arriba)
//   Posición 3 o 4  → la comisión se queda con su patrocinador directo
//
// Caso especial: si el usuario que debería recibirla no existe (porque
// estamos en la raíz DESP-000110, que no tiene patrocinador propio),
// la comisión la absorbe DESP-000110 — no se pierde, no sube más allá.
// ============================================================
async function obtenerPadreFinanciero(idUsuarioQueConsume) {
  const usuario = await Usuario.findOne({ id: idUsuarioQueConsume }, 'id referidoPor').lean();
  if (!usuario || !usuario.referidoPor) return null; // No tiene patrocinador (es la raíz misma)

  const patrocinador = await Usuario.findOne({ id: usuario.referidoPor }, 'id referidoPor referidos').lean();
  if (!patrocinador) return null;

  // Posición de este usuario dentro de los referidos de su patrocinador (orden de registro)
  const posicion = (patrocinador.referidos || []).indexOf(idUsuarioQueConsume); // 0-indexado

  // Posición 0 o 1 (1° o 2° invitado) → HEREDA el padre financiero de su propio patrocinador
  // (recursivo: si el patrocinador también era 1° o 2°, sigue subiendo en cadena)
  if (posicion === 0 || posicion === 1) {
    const padreFinancieroDelPatrocinador = await obtenerPadreFinanciero(patrocinador.id);
    // Si el patrocinador no tiene padre financiero propio (es la raíz), la raíz se la queda
    return padreFinancieroDelPatrocinador || patrocinador.id;
  }

  // Posición 2 o 3 (3° o 4° invitado) → se queda con el patrocinador directo
  return patrocinador.id;
}

async function buscarPosicionDisponible() {
  const todos = await Usuario.find({ archivado: { $ne: true } }, 'id nivel referidos').lean();
  if (todos.length === 0) return null; // No hay nadie todavía

  const nivelMax = Math.max(...todos.map(u => u.nivel || 0));

  for (let nv = 0; nv <= nivelMax; nv++) {
    const candidatos = todos
      .filter(u => (u.nivel || 0) === nv && (u.referidos ? u.referidos.length : 0) < limiteReferidos(u.id))
      .sort((a, b) => (a.referidos ? a.referidos.length : 0) - (b.referidos ? b.referidos.length : 0));
    if (candidatos.length > 0) return candidatos[0].id;
  }
  return null; // Red completamente llena (caso extremo)
}

// ============================================================
// SESIONES EN MEMORIA
// ============================================================
const sesiones = {};

// ============================================================
// ANTIFRAUDE AVANZADO — registro de intentos recientes
// ============================================================
const registrosRecientes = []; // [{ fecha, telefono }]
const LIMITE_REGISTROS_POR_HORA = 5; // umbral de alerta por abuso

function limpiarRegistrosViejos() {
  const haceUnaHora = Date.now() - (60 * 60 * 1000);
  while (registrosRecientes.length > 0 && registrosRecientes[0].fecha < haceUnaHora) {
    registrosRecientes.shift();
  }
}

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
    await axios.post(WASENDER_URL, {
      to: tel,
      text: caption,
      imageUrl: urlImagen
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
// ARCHIVADO AUTOMÁTICO POR INACTIVIDAD (60 días sin consumo)
// ============================================================
function obtenerUltimaFechaActividad(u) {
  const fechas = [];
  if (u.consumos && u.consumos.length > 0) {
    fechas.push(...u.consumos.map(c => new Date(c.fecha)));
  }
  if (u.pagos && u.pagos.length > 0) {
    fechas.push(...u.pagos.filter(p => p.estado === 'confirmado').map(p => new Date(p.fecha)));
  }
  fechas.push(new Date(u.fechaRegistro));
  return new Date(Math.max(...fechas.map(f => f.getTime())));
}

async function verificarArchivado() {
  try {
    console.log('Verificando archivado por inactividad...');
    const hoy = new Date();
    const usuarios = await Usuario.find({ archivado: { $ne: true } });

    for (const u of usuarios) {
      if (USUARIOS_EXENTOS.includes(u.id)) continue;

      const ultimaActividad = obtenerUltimaFechaActividad(u);
      const diasInactivo = Math.floor((hoy - ultimaActividad) / (1000 * 60 * 60 * 24));

      // Aviso 7 días antes de archivar (día 53 de inactividad)
      if (diasInactivo === 53) {
        await enviarMensaje(u.telefono,
          '⚠️ *AVISO DE INACTIVIDAD*\n\n' +
          'Hola *' + u.nombre + '* 👋\n\n' +
          'No hemos detectado consumo de tu parte en los últimos *53 días*.\n\n' +
          '📅 Si no hay actividad en *7 días más*, tu cuenta será archivada y tu lugar en la red quedará disponible para otro usuario.\n\n' +
          'Si deseas continuar, escribe *MENU* → opción *4* para registrar tu pago.\n\n' +
          'Si tienes dudas contacta al administrador:\n' +
          'https://wa.me/525576683884'
        );
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // Archivar a los 60 días de inactividad
      if (diasInactivo >= 60) {
        const patrocinadorId = u.referidoPor;

        await Usuario.updateOne(
          { id: u.id },
          {
            archivado: true,
            activo: false,
            fechaArchivado: hoy
          }
        );

        // Quitar de la lista de referidos del patrocinador para liberar su lugar
        if (patrocinadorId) {
          await Usuario.updateOne(
            { id: patrocinadorId },
            { $pull: { referidos: u.id } }
          );
        }

        await enviarMensaje(u.telefono,
          '📦 *CUENTA ARCHIVADA*\n\n' +
          'Hola *' + u.nombre + '*\n\n' +
          'Tu cuenta fue archivada por inactividad de más de 60 días.\n\n' +
          'Tu historial se conserva. Si deseas reactivarla, contacta al administrador:\n' +
          'https://wa.me/525576683884?text=Hola%2C%20quiero%20reactivar%20mi%20cuenta%20' + u.id
        );

        await enviarMensaje('5215585567250',
          '📦 *USUARIO ARCHIVADO POR INACTIVIDAD*\n\n' +
          '👤 ' + u.nombre + ' (' + u.id + ')\n' +
          '📅 Última actividad: ' + ultimaActividad.toLocaleDateString('es-MX') + '\n' +
          '⏳ Días inactivo: ' + diasInactivo + '\n\n' +
          'Su lugar en la red quedó disponible.\n' +
          'Para reactivar usa: *REACTIVAR ' + u.id + '*'
        );

        console.log('📦 Usuario archivado: ' + u.id + ' — ' + u.nombre);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.log('✅ Verificación de archivado completada');
  } catch (err) {
    console.error('❌ Error en archivado:', err.message);
  }
}

// Ejecutar verificación de archivado diario a las 8:30 AM hora Mexico (2:30 PM UTC)
function iniciarArchivado() {
  var ahora = new Date();
  var proximaEjecucion = new Date();
  proximaEjecucion.setUTCHours(14, 30, 0, 0);
  if (proximaEjecucion <= ahora) {
    proximaEjecucion.setDate(proximaEjecucion.getDate() + 1);
  }
  var tiempoEspera = proximaEjecucion - ahora;
  console.log('Próximo archivado en ' + Math.round(tiempoEspera/1000/60) + ' minutos');
  setTimeout(function() {
    verificarArchivado();
    setInterval(verificarArchivado, 24 * 60 * 60 * 1000);
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
    '5️⃣ Reportar un problema\n' +
    '6️⃣ ¿Qué es DespensaClub? / Quiero saber más\n\n' +
    '📲 Responde con el *numero* de tu opcion.';
}

// ============================================================
// LOGICA DEL BOT
// ============================================================
// ============================================================
// CONFIRMAR PAGO PENDIENTE (reutilizable: comando WhatsApp y escáner QR en sucursal)
// Retorna { ok: true, userU, pago, estabaCongelado, avisoComision } o { ok: false, motivo }
// ============================================================
async function confirmarPagoPendiente(idU) {
  const userU = await Usuario.findOne({ id: idU });
  if (!userU) return { ok: false, motivo: 'No encontré el usuario ' + idU };

  const pagoIdx = userU.pagos.findLastIndex(function(p) { return p.estado === 'pendiente'; });
  if (pagoIdx === -1) return { ok: false, motivo: 'No hay pagos pendientes para ' + idU };

  userU.pagos[pagoIdx].estado = 'confirmado';

  const estabaCongelado = userU.congelado || !userU.activo;
  userU.congelado = false;
  userU.activo = true;

  if (userU.pagos[pagoIdx].concepto === 'Membresía anual') {
    const nuevaVigencia = new Date();
    nuevaVigencia.setFullYear(nuevaVigencia.getFullYear() + 1);
    userU.vigencia = nuevaVigencia;
  }

  await userU.save();
  const pago = userU.pagos[pagoIdx];

  let avisoComision = '';
  if (pago.concepto === 'Despensa mensual') {
    const ahora = new Date();
    const consumosEsteMes = (userU.consumos || []).filter(c => {
      const fc = new Date(c.fecha);
      return c.descripcion === 'Despensa mensual' &&
             fc.getMonth() === ahora.getMonth() &&
             fc.getFullYear() === ahora.getFullYear();
    });
    if (consumosEsteMes.length >= 1) {
      await enviarMensaje('5215585567250',
        '🚨 *ACTIVIDAD INUSUAL*: ' + userU.nombre + ' (' + userU.id + ') ya registró ' + consumosEsteMes.length + ' consumo(s) de despensa este mes. Verifica que no sea un error o doble cobro.'
      );
    }

    await Usuario.updateOne(
      { id: userU.id },
      { $push: { consumos: { fecha: new Date(), descripcion: 'Despensa mensual' } } }
    );

    if (userU.referidoPor) {
      // Sistema 2-Up Split: determina quién realmente recibe la comisión
      // (el patrocinador directo, o el "padre financiero" un nivel más arriba,
      // según la posición de registro de userU entre los referidos de su patrocinador)
      const idBeneficiario = await obtenerPadreFinanciero(userU.id);
      const beneficiario = idBeneficiario ? await Usuario.findOne({ id: idBeneficiario }) : null;

      if (beneficiario) {
        await Usuario.updateOne(
          { id: beneficiario.id },
          { $push: { comisiones: {
            monto: CONFIG_PRECIOS.comisionReferido,
            deUsuario: userU.id,
            deNombre: userU.nombre,
            fecha: new Date(),
            pagada: false
          }}}
        );
        await enviarMensaje(beneficiario.telefono,
          '💰 *COMISIÓN GENERADA*\n\n' +
          'Tu red *' + userU.nombre + '* (' + userU.id + ') confirmó su pago de despensa.\n\n' +
          '🎁 Comisión: *$' + CONFIG_PRECIOS.comisionReferido + ' pesos*\n\n' +
          'Escribe *MIS COMISIONES* para ver tu total acumulado.'
        );
        avisoComision = 'Comisión de $' + CONFIG_PRECIOS.comisionReferido + ' generada para ' + beneficiario.id;
      }
    }
  }

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

  if (estabaCongelado && userU.referidoPor) {
    const patrocinador = await Usuario.findOne({ id: userU.referidoPor });
    if (patrocinador) {
      await enviarMensaje(patrocinador.telefono,
        '✅ *Tu referido se reactivó*\n\n' +
        '*' + userU.nombre + '* (' + userU.id + ') regularizó su pago y su cuenta está activa nuevamente.'
      );
    }
  }

  return { ok: true, userU, pago, estabaCongelado, avisoComision };
}

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

      // Antifraude: detectar ráfaga de registros nuevos en poco tiempo
      limpiarRegistrosViejos();
      registrosRecientes.push({ fecha: Date.now(), telefono: telLimpio });
      if (registrosRecientes.length > LIMITE_REGISTROS_POR_HORA) {
        await enviarMensaje('5215585567250',
          '🚨 *ALERTA ANTIFRAUDE*\n\n' +
          'Se detectaron *' + registrosRecientes.length + '* intentos de registro en la última hora.\n\n' +
          'Último teléfono: +' + telLimpio + '\n\n' +
          'Revisa si son registros legítimos.'
        );
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

      // Antifraude: verificación cruzada — bloquear si el teléfono ya existe (doble check por concurrencia)
      const telefonoDuplicado = await Usuario.findOne({ telefonoLimpio: telLimpio });
      if (telefonoDuplicado) {
        delete sesiones[telefono];
        await enviarMensaje(telefono,
          '⛔ *REGISTRO NO PERMITIDO*\n\n' +
          'Este número ya está registrado como *' + telefonoDuplicado.id + '*.\n\n' +
          'Si crees que es un error contacta al administrador:\n' +
          'https://wa.me/525576683884'
        );
        return;
      }

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
        // Verificar si el referidor ya alcanzó su límite de referidos
        const refCount = referidor.referidos ? referidor.referidos.length : 0;
        if (refCount >= limiteReferidos(referidor.id)) {
          await enviarMensaje(telefono,
            '⛔ *CODIGO NO DISPONIBLE*\n\n' +
            'El usuario con ese codigo ya completo sus lugares disponibles.\n\n' +
            'Contacta al administrador para mas informacion:\n' +
            'https://wa.me/525576683884?text=Hola%20necesito%20ayuda%20con%20un%20registro'
          );
          // Alertar al admin: alguien quiso ser el 5to invitado de un usuario ya lleno
          await enviarMensaje('5215585567250',
            '🚨 *EXCEDENTE DE REFERIDOS*\n\n' +
            'Alguien intentó registrarse con el código de *' + referidor.id + '* (' + referidor.nombre + '), pero ya tiene sus ' + limiteReferidos(referidor.id) + ' lugar(es) ocupados.\n\n' +
            '📱 Teléfono del interesado: +' + telLimpio + '\n\n' +
            'Decide manualmente dónde colocarlo y usa:\n*REASIGNAR <su-ID> <nuevo-patrocinador>*\n(primero pídele que complete su registro con código *NO* para que se le asigne un lugar temporal)'
          );
          return;
        }
        referidoPor = codigoReferido;
      } else {
        // Sin código: asignación automática inteligente balanceada por niveles
        referidoPor = await buscarPosicionDisponible();
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

      // Aviso de privacidad y solicitud de INE para expediente
      await new Promise(r => setTimeout(r, 2000));
      sesiones[telefono] = { paso: 'esperar_ine', datos: { idUsuario: nuevoID } };
      await enviarMensaje(telefono,
        '🔒 *AVISO DE PRIVACIDAD*\n\n' +
        'Para tu expediente, te pedimos una foto de tu identificación oficial (INE).\n\n' +
        '📋 Esta imagen:\n' +
        '• Se guarda únicamente como respaldo documental\n' +
        '• No se procesa ni se comparte con terceros\n' +
        '• Solo el administrador puede consultarla en caso de ser necesario\n' +
        '• Puedes solicitar su eliminación en cualquier momento escribiendo *ELIMINAR MI INE*\n\n' +
        '📸 Envía una foto de tu INE (frente), o escribe *OMITIR* si prefieres no hacerlo ahora.'
      );

      return;
    }

    // ── ESPERAR FOTO DE INE PARA EXPEDIENTE
    if (sesion.paso === 'esperar_ine') {
      if (texto.toUpperCase() === 'OMITIR') {
        delete sesiones[telefono];
        await enviarMensaje(telefono, '✅ Entendido, puedes enviarla más adelante escribiendo *MENU* si cambias de opinión.');
        return;
      }

      if (texto !== '__IMAGEN__') {
        await enviarMensaje(telefono, '📸 Por favor envía una *foto* de tu INE, o escribe *OMITIR*.');
        return;
      }

      const idUsuarioIne = sesion.datos.idUsuario;

      await Usuario.updateOne(
        { id: idUsuarioIne },
        { ineUrl: 'enviada_por_whatsapp', ineFecha: new Date() }
      );

      delete sesiones[telefono];
      await enviarMensaje(telefono, '✅ INE recibida y guardada en tu expediente. ¡Gracias!');

      await enviarMensaje('5215585567250',
        '🪪 *INE RECIBIDA*\n\n' +
        'Usuario: ' + idUsuarioIne + '\n' +
        'Revísala en este mismo chat de WhatsApp (arriba en el historial).'
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

    // ── COMANDO ELIMINAR MI INE (derecho de cancelación)
    if (texto === 'ELIMINAR MI INE' || texto === 'ELIMINARMIINE') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta registrada.');
        return;
      }
      if (!usuarioExistente.ineUrl) {
        await enviarMensaje(telefono, 'ℹ️ No tenemos ninguna INE guardada en tu expediente.');
        return;
      }
      await Usuario.updateOne(
        { id: usuarioExistente.id },
        { $unset: { ineUrl: '', ineFecha: '' } }
      );
      await enviarMensaje(telefono,
        '✅ *INE ELIMINADA*\n\n' +
        'Hemos eliminado el registro de tu identificación de nuestro expediente.\n\n' +
        'Esto no afecta el resto de tu cuenta ni tu membresía.'
      );
      await enviarMensaje('5215585567250',
        '🗑️ *INE ELIMINADA POR SOLICITUD*\n\n' +
        'Usuario: ' + usuarioExistente.nombre + ' (' + usuarioExistente.id + ')\n' +
        'Ejerció su derecho de cancelación.'
      );
      return;
    }

    // ── COMANDO MIS COMISIONES
    if (texto === 'MIS COMISIONES' || texto === 'MISCOMISIONES') {
      if (!usuarioExistente) {
        await enviarMensaje(telefono, '❌ No tienes cuenta registrada.\n\nEscribe *MENU* para registrarte.');
        return;
      }
      const comisiones = usuarioExistente.comisiones || [];
      const totalAcumulado = comisiones.reduce((s, c) => s + c.monto, 0);
      const pendientes = comisiones.filter(c => !c.pagada);
      const totalPendiente = pendientes.reduce((s, c) => s + c.monto, 0);

      let detalle = '';
      if (comisiones.length > 0) {
        detalle = [...comisiones].reverse().slice(0, 10).map(c =>
          '• $' + c.monto + ' — de ' + c.deNombre + ' (' + new Date(c.fecha).toLocaleDateString('es-MX') + ')' +
          (c.pagada ? ' ✅' : ' ⏳')
        ).join('\n');
      }

      await enviarMensaje(telefono,
        '💰 *MIS COMISIONES*\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        '💵 Total acumulado: *$' + totalAcumulado + ' pesos*\n' +
        '⏳ Pendiente de pago: *$' + totalPendiente + ' pesos*\n\n' +
        (detalle ? '*Últimas comisiones:*\n' + detalle : 'Aún no tienes comisiones generadas.\n\n¡Invita a tus familiares y gana $' + CONFIG_PRECIOS.comisionReferido + ' por cada despensa que consuman!')
      );
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
      const miLimite = limiteReferidos(u.id);
      const restantes = miLimite - u.referidos.length;

      // Bloquear si ya alcanzó su límite de referidos
      if (u.referidos.length >= miLimite) {
        await enviarMensaje(telefono,
          '⛔ *YA COMPLETASTE TUS ' + miLimite + ' REFERIDO' + (miLimite > 1 ? 'S' : '') + '*\n\n' +
          'Tu estructura esta completa con:\n' +
          u.referidos.map(function(r, i) { return (i+1) + '. ' + r; }).join('\n') + '\n\n' +
          'Si deseas hacer algun cambio comunicate directamente con el administrador.\n\n' +
          '📱 Contactar admin:\nhttps://wa.me/525576683884?text=Hola%20necesito%20ayuda%20con%20mis%20referidos'
        );
        return;
      }
      await enviarMensaje(telefono,
        '👥 *INVITAR REFERIDOS*\n\n' +
        'Tu codigo para invitar es:\n*' + u.id + '*\n' +
        'Tienes *' + u.referidos.length + '/' + miLimite + '* referidos. Te faltan *' + restantes + '*.\n' +
        '_Comparte este mensaje_\n\n' +
        '🛒 *DESPENSACLUB*\n' +
        '_Comunidad de Consumo Inteligente_\n\n' +
        'Convierte tus compras de despensa en ahorro.🤑 $\n\n' +
        '✔️ Membresía anual: $50 pesos\n' +
        '✔️ Despensa mensual: $250 pesos\n' +
        '✔️ Beneficios por invitar a otros consumidores\n\n' +
        '➡️📲 Regístrate aquí:\n' +
        'https://wa.me/525576683884?text=HOLA\n\n' +
        '👇👇⚠️*IMPORTANTE NO LO OLVIDES*👇👇\n\n' +
        '🔑 *CÓDIGO DE INVITACIÓN*\n' +
        '✨ *' + u.id + '* ✨\n\n' +
        'Escríbelo durante tu registro para que tu invitación quede registrada correctamente.'
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
        '1️⃣ Membresía anual — *$' + CONFIG_PRECIOS.membresia + ' pesos*\n' +
        '2️⃣ Despensa mensual — *$' + CONFIG_PRECIOS.despensa + ' pesos*\n\n' +
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
      const monto = texto === '1' ? CONFIG_PRECIOS.membresia : CONFIG_PRECIOS.despensa;
      sesiones[telefono] = { paso: 'pedir_metodo_pago', datos: { concepto, monto } };

      await enviarMensaje(telefono,
        '💳 *¿CÓMO VAS A PAGAR?*\n\n' +
        'Concepto: *' + concepto + '*\n' +
        'Monto: *$' + monto + ' pesos*\n\n' +
        '1️⃣ CoDi (transferencia desde tu banco)\n' +
        '2️⃣ Efectivo al momento de recoger mi despensa\n\n' +
        'Responde con *1* o *2*'
      );
      return;
    }

    if (sesion.paso === 'pedir_metodo_pago') {
      if (texto !== '1' && texto !== '2') {
        await enviarMensaje(telefono, '❌ Responde solo con *1* o *2*');
        return;
      }
      const { concepto, monto } = sesion.datos;

      // Pago en efectivo: se registra como pendiente, se confirma al recoger en sucursal
      if (texto === '2') {
        const fecha = new Date();
        await Usuario.updateOne(
          { telefono: telefono },
          { $push: { pagos: {
            concepto: concepto,
            monto: monto,
            fecha: fecha,
            estado: 'pendiente',
            metodoPago: 'efectivo',
            comprobante: 'pago_en_efectivo_pendiente'
          }}}
        );
        delete sesiones[telefono];

        await enviarMensaje(telefono,
          '✅ *PAGO EN EFECTIVO REGISTRADO*\n\n' +
          'Concepto: *' + concepto + '*\n' +
          'Monto: *$' + monto + ' pesos*\n' +
          'Estado: ⏳ Pendiente — paga en efectivo al recoger\n\n' +
          'Tu credencial digital será escaneada en sucursal para confirmar tu pago automáticamente.'
        );

        await enviarMensaje('5215585567250',
          '💵 *PAGO EN EFECTIVO PROGRAMADO*\n\n' +
          '👤 ' + usuarioExistente.nombre + '\n' +
          '🪪 ' + usuarioExistente.id + '\n' +
          '📱 +' + telLimpio + '\n' +
          '💵 Concepto: ' + concepto + '\n' +
          '💵 Monto: $' + monto + ' pesos (EFECTIVO)\n' +
          '📅 ' + fecha.toLocaleDateString('es-MX') + '\n\n' +
          'Se confirmará automáticamente al escanear su credencial en sucursal, o manualmente con:\n*CONFIRMAR ' + usuarioExistente.id + '*'
        );
        return;
      }

      // Pago con CoDi: continúa el flujo original con QR
      sesiones[telefono] = { paso: 'esperar_comprobante', datos: { concepto, monto } };

      await enviarImagen(telefono, QR_CODI_URL,
        '💳 *PAGA CON CoDi®*\n\n' +
        'Escanea este código desde tu app bancaria (cualquier banco).\n\n' +
        'Concepto: *' + concepto + '*\n' +
        '💵 Monto a pagar: *$' + monto + ' pesos*\n\n' +
        '✅ Sin comisiones, pago directo e instantáneo.'
      );

      await new Promise(r => setTimeout(r, 1500));

      await enviarMensaje(telefono,
        '📸 *SUBE TU COMPROBANTE*\n\n' +
        'Una vez realizado el pago, envía una *foto o captura* de tu comprobante.\n\n' +
        '⚠️ Asegúrate que se vea claramente el monto y la fecha.'
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

      // Antifraude: detectar múltiples comprobantes en poco tiempo (posible reuso/fraude)
      const haceUnaHora = new Date(fecha.getTime() - 60 * 60 * 1000);
      const comprobantesRecientes = (usuarioExistente.pagos || []).filter(p => new Date(p.fecha) > haceUnaHora);
      let avisoFraude = '';
      if (comprobantesRecientes.length >= 2) {
        avisoFraude = '\n\n🚨 *ALERTA*: este usuario envió ' + (comprobantesRecientes.length + 1) + ' comprobantes en la última hora. Revisa con cuidado antes de confirmar.';
      }

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
        'Para rechazar escribe:\n*RECHAZAR ' + usuarioExistente.id + '*' +
        avisoFraude
      );
      return;
    }

    // ── OPCION 5: REPORTE
    if (sesion.paso === 'menu' && texto === '5') {
      sesiones[telefono] = { paso: 'pedir_reporte', datos: {} };
      await enviarMensaje(telefono, '📝 *REPORTAR PROBLEMA*\n\nDescribe tu problema:');
      return;
    }

    // ── OPCION 6: QUE ES DESPENSACLUB
    if (sesion.paso === 'menu' && texto === '6') {
      await enviarMensaje(telefono,
        '🛒 *¿QUÉ ES DESPENSACLUB FAMILIAR?*\n\n' +
        'Somos una comunidad familiar de consumo inteligente. Cada mes juntamos a varias familias para conseguir despensas a mejor precio, y cada quien recoge la suya.\n\n' +
        '✅ *No es un fraude ni una pirámide financiera.* No prometemos hacerte rico, no manejamos inversiones ni rendimientos de dinero. Es un club de consumo real: pagas por una despensa real que recibes cada mes.\n\n' +
        '🔍 *¿Por qué te llegó por invitación?*\n' +
        'Porque alguien de tu confianza (un amigo o familiar) ya forma parte del club y quiso compartirte el beneficio. Así crece: de boca en boca, entre gente conocida.\n\n' +
        '⚙️ *¿Cómo funciona?*\n' +
        '1️⃣ Pagas tu membresía una vez al año: $50 pesos\n' +
        '2️⃣ Cada mes pagas y recoges tu despensa: $250 pesos\n' +
        '3️⃣ Si invitas a otras personas que también consuman, ganas una pequeña comisión por cada despensa mensual que ellas recojan\n\n' +
        '🎥 *Videos explicativos (ejemplos del modelo, mientras preparamos el nuestro):*\n' +
        'https://youtu.be/5QV5XiR_e7I\n' +
        'https://youtu.be/tkd8s_HcTJY\n' +
        'https://youtu.be/-CQCqb45UOk\n\n' +
        '¿Listo para registrarte? Escribe *MENU* y elige la opción 1.'
      );
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

      // ── CAMBIAR TELEFONO: para clientes que perdieron o cambiaron su celular
      if (texto.startsWith('CAMBIAR TELEFONO ')) {
        const partes = texto.replace('CAMBIAR TELEFONO ', '').trim().split(' ');
        if (partes.length !== 2) {
          await enviarMensaje(telefono, '❌ Formato: *CAMBIAR TELEFONO DESP-000XXX 5512345678*\n(10 dígitos, sin espacios ni guiones)');
          return;
        }
        const [idCambiar, telNuevo] = partes;
        const telNuevoLimpio = telNuevo.replace(/\D/g, '');
        if (telNuevoLimpio.length !== 10) {
          await enviarMensaje(telefono, '❌ El teléfono debe tener exactamente 10 dígitos. Recibí: ' + telNuevo);
          return;
        }

        const userCambiar = await Usuario.findOne({ id: idCambiar.toUpperCase() });
        if (!userCambiar) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idCambiar); return; }

        const telefonoAnterior = userCambiar.telefono;
        const yaExiste = await Usuario.findOne({ telefonoLimpio: telNuevoLimpio });
        if (yaExiste && yaExiste.id !== userCambiar.id) {
          await enviarMensaje(telefono, '❌ Ese número ya está registrado con la cuenta ' + yaExiste.id + ' (' + yaExiste.nombre + ').');
          return;
        }

        userCambiar.telefono = '521' + telNuevoLimpio;
        userCambiar.telefonoLimpio = telNuevoLimpio;
        await userCambiar.save();

        await enviarMensaje(telefono,
          '✅ *TELÉFONO ACTUALIZADO*\n\n' +
          '👤 ' + userCambiar.nombre + ' (' + idCambiar.toUpperCase() + ')\n' +
          '📱 Anterior: ' + telefonoAnterior + '\n' +
          '📱 Nuevo: 521' + telNuevoLimpio
        );

        // Avisar al cliente desde su número nuevo
        await enviarMensaje('521' + telNuevoLimpio,
          '👋 Hola *' + userCambiar.nombre + '*\n\n' +
          'Tu número de contacto en DespensaClub Familiar fue actualizado correctamente a este WhatsApp.\n\n' +
          'Escribe *MENU* para ver tus opciones.'
        );
        return;
      }

      // ── AVISO: mensaje masivo a todos los usuarios activos (mantenimiento, precios, avisos generales)
      if (texto.startsWith('AVISO ')) {
        const mensajeAviso = mensaje.replace(/^AVISO /i, '').trim();
        if (!mensajeAviso) {
          await enviarMensaje(telefono, '❌ Escribe el mensaje después de AVISO. Ejemplo:\n*AVISO Mañana el sistema estará en mantenimiento de 2 a 4 PM.*');
          return;
        }

        const todosActivos = await Usuario.find({ activo: true }, 'telefono nombre').lean();
        await enviarMensaje(telefono, '📢 Enviando aviso a ' + todosActivos.length + ' usuario(s) activo(s)...');

        let enviados = 0;
        for (const dest of todosActivos) {
          try {
            await enviarMensaje(dest.telefono,
              '📢 *AVISO DE DESPENSACLUB FAMILIAR*\n\n' + mensajeAviso
            );
            enviados++;
            await new Promise(r => setTimeout(r, 300)); // pequeña pausa entre envíos
          } catch (e) {
            // continúa aunque falle uno
          }
        }

        await enviarMensaje(telefono, '✅ Aviso enviado a ' + enviados + ' de ' + todosActivos.length + ' usuarios.');
        return;
      }

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

      if (texto.startsWith('ELIMINAR ') && !texto.startsWith('ELIMINAR CONFIRMAR')) {
        const idEliminar = texto.replace('ELIMINAR ', '').trim().toUpperCase();
        const userEliminar = await Usuario.findOne({ id: idEliminar });
        if (!userEliminar) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idEliminar); return; }
        if (USUARIOS_EXENTOS.includes(idEliminar)) {
          await enviarMensaje(telefono, '⛔ ' + idEliminar + ' es una cuenta exenta y no se puede eliminar.');
          return;
        }
        await enviarMensaje(telefono,
          '⚠️ *CONFIRMAR ELIMINACIÓN*\n\n' +
          '👤 ' + userEliminar.nombre + ' (' + idEliminar + ')\n' +
          '👥 Referidos: ' + (userEliminar.referidos ? userEliminar.referidos.length : 0) + '\n' +
          '💰 Pagos registrados: ' + (userEliminar.pagos ? userEliminar.pagos.length : 0) + '\n\n' +
          '🚨 Esta acción es *PERMANENTE* y borra todo su historial.\n\n' +
          'Para confirmar escribe:\n*ELIMINAR CONFIRMAR ' + idEliminar + '*'
        );
        return;
      }

      if (texto.startsWith('ELIMINAR CONFIRMAR ')) {
        const idEliminar = texto.replace('ELIMINAR CONFIRMAR ', '').trim().toUpperCase();
        const userEliminar = await Usuario.findOne({ id: idEliminar });
        if (!userEliminar) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idEliminar); return; }
        if (USUARIOS_EXENTOS.includes(idEliminar)) {
          await enviarMensaje(telefono, '⛔ ' + idEliminar + ' es una cuenta exenta y no se puede eliminar.');
          return;
        }

        // Liberar su lugar quitándolo de los referidos de su patrocinador
        if (userEliminar.referidoPor) {
          await Usuario.updateOne(
            { id: userEliminar.referidoPor },
            { $pull: { referidos: idEliminar } }
          );
        }

        // Reasignar sus propios referidos directos al patrocinador de este usuario (evita huérfanos)
        if (userEliminar.referidos && userEliminar.referidos.length > 0) {
          for (const refId of userEliminar.referidos) {
            await Usuario.updateOne(
              { id: refId },
              { referidoPor: userEliminar.referidoPor || null, nivel: Math.max((userEliminar.nivel || 0), 0) }
            );
            if (userEliminar.referidoPor) {
              await Usuario.updateOne(
                { id: userEliminar.referidoPor },
                { $addToSet: { referidos: refId } }
              );
            }
          }
        }

        await Usuario.deleteOne({ id: idEliminar });

        await enviarMensaje(telefono,
          '✅ *USUARIO ELIMINADO*\n\n' +
          idEliminar + ' (' + userEliminar.nombre + ') fue eliminado permanentemente.\n\n' +
          (userEliminar.referidos && userEliminar.referidos.length > 0
            ? '👥 Sus ' + userEliminar.referidos.length + ' referido(s) fueron reasignados a su antiguo patrocinador.'
            : '')
        );
        return;
      }

      if (texto.startsWith('REASIGNAR ')) {
        const partes = texto.replace('REASIGNAR ', '').trim().split(' ');
        if (partes.length !== 2) {
          await enviarMensaje(telefono, '❌ Formato incorrecto.\n\nUsa: *REASIGNAR DESP-000XXX DESP-000YYY*\n(usuario a mover, nuevo patrocinador)');
          return;
        }
        const idMover = partes[0].toUpperCase();
        const idNuevoPatrocinador = partes[1].toUpperCase();

        if (idMover === idNuevoPatrocinador) {
          await enviarMensaje(telefono, '❌ No puedes asignar un usuario como su propio patrocinador.');
          return;
        }

        const usuarioMover = await Usuario.findOne({ id: idMover });
        if (!usuarioMover) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idMover); return; }

        const nuevoPatrocinador = await Usuario.findOne({ id: idNuevoPatrocinador });
        if (!nuevoPatrocinador) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idNuevoPatrocinador); return; }

        // Evitar mover a alguien debajo de uno de sus propios referidos (ciclo)
        let cursor = nuevoPatrocinador;
        while (cursor) {
          if (cursor.id === idMover) {
            await enviarMensaje(telefono, '❌ No puedes mover a un usuario debajo de su propio referido (crearía un ciclo).');
            return;
          }
          cursor = cursor.referidoPor ? await Usuario.findOne({ id: cursor.referidoPor }) : null;
        }

        // Verificar espacio disponible en el nuevo patrocinador
        const refCount = nuevoPatrocinador.referidos ? nuevoPatrocinador.referidos.length : 0;
        if (refCount >= limiteReferidos(nuevoPatrocinador.id)) {
          await enviarMensaje(telefono, '❌ ' + idNuevoPatrocinador + ' ya tiene sus lugares ocupados.');
          return;
        }

        const patrocinadorAnteriorId = usuarioMover.referidoPor;

        // Quitar de la lista de referidos del patrocinador anterior
        if (patrocinadorAnteriorId) {
          await Usuario.updateOne(
            { id: patrocinadorAnteriorId },
            { $pull: { referidos: idMover } }
          );
        }

        // Agregar a la lista de referidos del nuevo patrocinador
        await Usuario.updateOne(
          { id: idNuevoPatrocinador },
          { $push: { referidos: idMover } }
        );

        // Actualizar al usuario movido: nuevo patrocinador y nuevo nivel
        const nuevoNivel = (nuevoPatrocinador.nivel || 0) + 1;
        await Usuario.updateOne(
          { id: idMover },
          { referidoPor: idNuevoPatrocinador, nivel: nuevoNivel }
        );

        await enviarMensaje(telefono,
          '✅ *REASIGNACIÓN COMPLETADA*\n\n' +
          '👤 ' + usuarioMover.nombre + ' (' + idMover + ')\n' +
          '📤 Antes: ' + (patrocinadorAnteriorId || 'Sin patrocinador') + '\n' +
          '📥 Ahora: ' + idNuevoPatrocinador + '\n' +
          '🎨 Nuevo nivel: ' + nuevoNivel
        );

        await enviarMensaje(usuarioMover.telefono,
          '📋 *ACTUALIZACIÓN DE RED*\n\n' +
          'Hola *' + usuarioMover.nombre + '*\n\n' +
          'Tu posición en la red de DespensaClub fue actualizada por el administrador.\n\n' +
          'Si tienes dudas contacta al administrador.'
        );
        return;
      }

      if (texto === 'VERIFICAR') {
        await enviarMensaje(telefono, '❄️ Verificando congelamientos...');
        await verificarCongelamiento();
        await enviarMensaje(telefono, '✅ Verificación completada.');
        return;
      }

      if (texto === 'ANTIFRAUDE') {
        limpiarRegistrosViejos();
        const todosU = await Usuario.find({}, 'telefonoLimpio pagos').lean();
        let comprobantesUltimaHora = 0;
        const haceUnaHora2 = new Date(Date.now() - 60 * 60 * 1000);
        for (const u of todosU) {
          if (u.pagos) {
            comprobantesUltimaHora += u.pagos.filter(p => new Date(p.fecha) > haceUnaHora2).length;
          }
        }
        await enviarMensaje(telefono,
          '🛡️ *ESTADO ANTIFRAUDE*\n\n' +
          '📝 Registros última hora: ' + registrosRecientes.length + '/' + LIMITE_REGISTROS_POR_HORA + '\n' +
          '💰 Comprobantes última hora: ' + comprobantesUltimaHora + '\n\n' +
          'Protecciones activas:\n' +
          '✅ Nombres similares/duplicados\n' +
          '✅ Teléfonos duplicados\n' +
          '✅ Ráfaga de registros\n' +
          '✅ Comprobantes múltiples sospechosos\n' +
          '✅ Consumos duplicados por mes'
        );
        return;
      }

      if (texto === 'VERIFICAR ARCHIVADO') {
        await enviarMensaje(telefono, '📦 Verificando inactividad...');
        await verificarArchivado();
        await enviarMensaje(telefono, '✅ Verificación de archivado completada.');
        return;
      }

      if (texto.startsWith('REACTIVAR ')) {
        const idU = texto.replace('REACTIVAR ', '').trim().toUpperCase();
        const userU = await Usuario.findOne({ id: idU });
        if (!userU) { await enviarMensaje(telefono, '❌ No encontré el usuario ' + idU); return; }
        if (!userU.archivado) { await enviarMensaje(telefono, 'ℹ️ ' + idU + ' no está archivado.'); return; }

        await Usuario.updateOne(
          { id: idU },
          { archivado: false, activo: true, fechaArchivado: null }
        );

        // Reasignar su lugar si el patrocinador original sigue activo y con espacio
        if (userU.referidoPor) {
          const patrocinador = await Usuario.findOne({ id: userU.referidoPor });
          if (patrocinador && !patrocinador.archivado && (patrocinador.referidos ? patrocinador.referidos.length : 0) < 4) {
            await Usuario.updateOne({ id: patrocinador.id }, { $addToSet: { referidos: idU } });
          }
        }

        await enviarMensaje(telefono, '✅ ' + userU.nombre + ' (' + idU + ') reactivado correctamente.');
        await enviarMensaje(userU.telefono,
          '🎉 *TU CUENTA HA SIDO REACTIVADA*\n\n' +
          'Hola *' + userU.nombre + '*, tu cuenta en DespensaClub está activa nuevamente. ¡Bienvenido de vuelta! 🛒'
        );
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
        const resultado = await confirmarPagoPendiente(idU);
        if (!resultado.ok) { await enviarMensaje(telefono, '❌ ' + resultado.motivo); return; }
        const { userU, pago, estabaCongelado, avisoComision } = resultado;

        await enviarMensaje(telefono,
          '✅ *PAGO CONFIRMADO*\n\n' +
          '👤 ' + userU.nombre + '\n' +
          '🪪 ' + idU + '\n' +
          '💵 ' + pago.concepto + ' — $' + pago.monto + ' pesos' +
          (estabaCongelado ? '\n\n❄️➡️✅ Cuenta reactivada automáticamente.' : '') +
          (avisoComision ? '\n💰 ' + avisoComision : '')
        );
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
      9: { bg: '#9E9E9E', text: '#fff', nombre: 'GRIS' },
      10: { bg: '#F44336', text: '#fff', nombre: 'ROJO' },
      11: { bg: '#03A9F4', text: '#fff', nombre: 'CELESTE' },
      12: { bg: '#9C27B0', text: '#fff', nombre: 'MAGENTA' },
      13: { bg: '#8BC34A', text: '#000', nombre: 'LIMA' },
      14: { bg: '#FF7043', text: '#fff', nombre: 'CORAL' },
      15: { bg: '#3F51B5', text: '#fff', nombre: 'ÍNDIGO' },
      16: { bg: '#009688', text: '#fff', nombre: 'MENTA' },
      17: { bg: '#795548', text: '#fff', nombre: 'BRONCE' },
      18: { bg: '#CE93D8', text: '#000', nombre: 'LAVANDA' },
      19: { bg: '#00897B', text: '#fff', nombre: 'ESMERALDA' }
    };

    const color = COLORES_HEX[usuario.nivel || 0] || COLORES_HEX[0];
    const fechaReg = new Date(usuario.fechaRegistro).toLocaleDateString('es-MX');
    const vigencia = usuario.vigencia ? new Date(usuario.vigencia).toLocaleDateString('es-MX') : 'N/A';
    const qrData = encodeURIComponent('https://despensas-bot-production.up.railway.app/admin/escanear/' + usuario.id + '?key=abb46f223b7cec4e6e3781421d2d1cd5');
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${qrData}&color=${color.bg.replace('#','')}`;

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
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
      8: '#1B5E20', 9: '#9E9E9E', 10: '#F44336', 11: '#03A9F4',
      12: '#9C27B0', 13: '#8BC34A', 14: '#FF7043', 15: '#3F51B5',
      16: '#009688', 17: '#795548', 18: '#CE93D8', 19: '#00897B'
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
    <input type="hidden" name="key" value="abb46f223b7cec4e6e3781421d2d1cd5">
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
      <a class="btn-ver" href="/admin/usuario/${u.id}?key=abb46f223b7cec4e6e3781421d2d1cd5">Ver expediente completo →</a>
    </div>`;
  }).join('')}

  <a class="back" href="/admin/dashboard?key=abb46f223b7cec4e6e3781421d2d1cd5">← Volver al Dashboard</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Vista detallada de usuario individual
// Guardar nota del administrador sobre un usuario
app.post('/admin/usuario/:id/nota', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const idU = req.params.id.toUpperCase();
    await Usuario.updateOne({ id: idU }, { notasAdmin: req.body.nota || '' });
    res.redirect('/admin/usuario/' + idU + '?key=abb46f223b7cec4e6e3781421d2d1cd5');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/usuario/:id', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const u = await Usuario.findOne({ id: req.params.id.toUpperCase() }).lean();
    if (!u) return res.status(404).send('Usuario no encontrado');

    const COLORES_HEX = {
      0: '#7B2FBE', 1: '#F5A623', 2: '#2196F3', 3: '#FF6B2B',
      4: '#E91E8C', 5: '#4CAF50', 6: '#FFC107', 7: '#00BCD4',
      8: '#1B5E20', 9: '#9E9E9E', 10: '#F44336', 11: '#03A9F4',
      12: '#9C27B0', 13: '#8BC34A', 14: '#FF7043', 15: '#3F51B5',
      16: '#009688', 17: '#795548', 18: '#CE93D8', 19: '#00897B'
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
    .btn { padding: 10px; border-radius: 8px; text-align: center; font-size: 12px; font-weight: bold; text-decoration: none; display: block; cursor: pointer; border: none; }
    .btn-confirmar { background: #1b5e20; color: #fff; }
    .btn-desactivar { background: #b71c1c; color: #fff; }
    .btn-activar { background: #0d47a1; color: #fff; }
    .btn-cred { background: #7B2FBE; color: #fff; }
    .btn-imprimir { background: #444; color: #fff; }
    .back { display: block; text-align: center; margin-top: 16px; color: #25D366; text-decoration: none; font-size: 13px; }
    .alerta-archivado { background: #5d4037; border-radius: 8px; padding: 10px; margin-bottom: 12px; font-size: 12px; }
    textarea { width: 100%; min-height: 70px; background: #0f3460; color: #fff; border: none; border-radius: 8px; padding: 10px; font-size: 12px; font-family: sans-serif; resize: vertical; }
    .btn-guardar-nota { margin-top: 8px; padding: 8px 16px; background: #25D366; color: #000; border-radius: 8px; border: none; font-size: 12px; font-weight: bold; cursor: pointer; }
    @media print {
      body { background: #fff; color: #000; }
      .seccion { background: #f5f5f5; border: 1px solid #ccc; }
      .acciones, .back, .btn-guardar-nota { display: none !important; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="nombre">${u.nombre.toUpperCase()}</div>
    <div class="id">${u.id} — Nivel ${u.nivel || 0}</div>
    <div style="margin-top:6px;font-size:12px">${u.congelado ? '❄️ Congelado' : u.activo ? '✅ Activo' : '❌ Inactivo'}${u.archivado ? ' 📦 Archivado' : ''}</div>
  </div>

  ${u.archivado ? `
  <div class="alerta-archivado">
    📦 Este usuario fue <strong>archivado</strong> el ${new Date(u.fechaArchivado).toLocaleDateString('es-MX')} por inactividad.
    Usa <strong>REACTIVAR ${u.id}</strong> por WhatsApp para recuperarlo.
  </div>` : ''}

  <div class="acciones">
    <a class="btn btn-cred" href="/credencial/${u.id}" target="_blank">🪪 Ver credencial</a>
    ${u.activo ? `<a class="btn btn-desactivar" href="/admin/accion/${u.id}/desactivar?key=abb46f223b7cec4e6e3781421d2d1cd5">❌ Desactivar</a>` :
                 `<a class="btn btn-activar" href="/admin/accion/${u.id}/activar?key=abb46f223b7cec4e6e3781421d2d1cd5">✅ Activar</a>`}
  </div>
  <div class="acciones">
    <button class="btn btn-imprimir" onclick="window.print()" style="grid-column: span 2;">🖨️ Imprimir / Exportar expediente</button>
  </div>

  <div class="seccion">
    <h3>📋 Datos personales</h3>
    <div class="fila"><span class="fila-label">📱 Teléfono</span><span>${u.telefonoLimpio || 'N/A'}</span></div>
    <div class="fila"><span class="fila-label">📅 Registro</span><span>${new Date(u.fechaRegistro).toLocaleDateString('es-MX')}</span></div>
    <div class="fila"><span class="fila-label">⏳ Vigencia</span><span>${vigenciaStr}</span></div>
    <div class="fila"><span class="fila-label">👥 Referido por</span><span>${u.referidoPor || 'Directo'}</span></div>
    <div class="fila"><span class="fila-label">👥 Referidos</span><span>${u.referidos ? u.referidos.join(', ') || 'Ninguno' : 'Ninguno'}</span></div>
    <div class="fila"><span class="fila-label">🪪 INE en expediente</span><span>${u.ineUrl ? '✅ Recibida (' + new Date(u.ineFecha).toLocaleDateString('es-MX') + ')' : '❌ No enviada'}</span></div>
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

  <div class="seccion">
    <h3>💰 Comisiones generadas</h3>
    ${u.comisiones && u.comisiones.length > 0 ? `
      <div class="fila" style="font-weight:bold">
        <span>Total acumulado</span><span class="estado-conf">$${u.comisiones.reduce((s,c) => s + c.monto, 0)} pesos</span>
      </div>
      ${[...u.comisiones].reverse().map(c => `
        <div class="pago-item">
          <div>💵 $${c.monto} — de ${c.deNombre}</div>
          <div style="color:#aaa">${new Date(c.fecha).toLocaleDateString('es-MX')} ${c.pagada ? '✅ Pagada' : '⏳ Pendiente'}</div>
        </div>
      `).join('')}
    ` : '<div class="vacio">Sin comisiones generadas</div>'}
  </div>

  <div class="seccion">
    <h3>📝 Notas del administrador</h3>
    <form method="POST" action="/admin/usuario/${u.id}/nota?key=abb46f223b7cec4e6e3781421d2d1cd5">
      <textarea name="nota" placeholder="Escribe notas internas sobre este usuario (no visibles para él)...">${u.notasAdmin || ''}</textarea>
      <button type="submit" class="btn-guardar-nota">💾 Guardar nota</button>
    </form>
  </div>

  <a class="back" href="/admin/usuarios?key=abb46f223b7cec4e6e3781421d2d1cd5">← Volver a lista</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Acciones rápidas sobre usuario
app.get('/admin/accion/:id/:accion', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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

    res.redirect('/admin/usuario/' + u.id + '?key=abb46f223b7cec4e6e3781421d2d1cd5');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/predictivo', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
    return res.status(403).send('Acceso denegado');
  }
  try {
    const hoy = new Date();
    const todos = await Usuario.find({}).lean();
    const activos = todos.filter(u => u.activo && !u.congelado);
    const exentos = todos.filter(u => USUARIOS_EXENTOS.includes(u.id));
    const noExentos = todos.filter(u => !USUARIOS_EXENTOS.includes(u.id));
    const activosNoExentos = activos.filter(u => !USUARIOS_EXENTOS.includes(u.id));

    // Ingresos mensuales históricos (últimos 6 meses)
    const ingresosPorMes = {};
    for (let i = 5; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const clave = fecha.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' });
      ingresosPorMes[clave] = 0;
    }
    for (const u of todos) {
      if (!u.pagos) continue;
      for (const p of u.pagos) {
        if (p.estado !== 'confirmado') continue;
        const fp = new Date(p.fecha);
        const clave = fp.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' });
        if (ingresosPorMes.hasOwnProperty(clave)) {
          ingresosPorMes[clave] += p.monto || 0;
        }
      }
    }
    const valoresIngresos = Object.values(ingresosPorMes);
    const promedioIngresoMensual = valoresIngresos.reduce((a, b) => a + b, 0) / (valoresIngresos.filter(v => v > 0).length || 1);

    // Proyección próximo mes: usuarios activos esperados x precio despensa
    const ingresoProyectadoDespensas = activosNoExentos.length * CONFIG_PRECIOS.despensa;

    // Renovaciones esperadas próximos 30 días
    const renovacionesProximas = todos.filter(u => {
      if (!u.vigencia) return false;
      const dias = Math.ceil((new Date(u.vigencia) - hoy) / (1000 * 60 * 60 * 24));
      return dias > 0 && dias <= 30;
    });
    const ingresoProyectadoRenovaciones = renovacionesProximas.length * CONFIG_PRECIOS.membresia;

    const ingresoProyectadoTotal = ingresoProyectadoDespensas + ingresoProyectadoRenovaciones;

    // Tasa de abandono: congelados+inactivos / total no exentos
    const congeladosInactivos = noExentos.filter(u => u.congelado || !u.activo).length;
    const tasaAbandono = noExentos.length > 0 ? ((congeladosInactivos / noExentos.length) * 100).toFixed(1) : '0.0';

    // Crecimiento de red: registros por mes (últimos 6 meses)
    const registrosPorMes = {};
    for (let i = 5; i >= 0; i--) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const clave = fecha.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' });
      registrosPorMes[clave] = 0;
    }
    for (const u of todos) {
      const fr = new Date(u.fechaRegistro);
      const clave = fr.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' });
      if (registrosPorMes.hasOwnProperty(clave)) {
        registrosPorMes[clave]++;
      }
    }
    const valoresRegistros = Object.values(registrosPorMes);
    const crecimientoPromedioMensual = (valoresRegistros.reduce((a, b) => a + b, 0) / 6).toFixed(1);
    const ultimoMes = valoresRegistros[valoresRegistros.length - 1];
    const penultimoMes = valoresRegistros[valoresRegistros.length - 2] || 0;
    const tendencia = ultimoMes >= penultimoMes ? '📈 Creciendo' : '📉 Bajando';

    // Comisiones totales pendientes de pago a patrocinadores
    let comisionesPendientes = 0;
    for (const u of todos) {
      if (u.comisiones) {
        comisionesPendientes += u.comisiones.filter(c => !c.pagada).reduce((s, c) => s + c.monto, 0);
      }
    }

    const maxBarraIngresos = Math.max(...valoresIngresos, 1);
    const maxBarraRegistros = Math.max(...valoresRegistros, 1);

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard Predictivo — DespensaClub</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #1a1a2e; color: #fff; padding: 16px; }
    h1 { text-align: center; color: #25D366; font-size: 19px; margin-bottom: 4px; }
    .sub { text-align: center; color: #aaa; font-size: 12px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
    .card { background: #16213e; border-radius: 12px; padding: 16px; text-align: center; }
    .card-num { font-size: 26px; font-weight: bold; }
    .card-label { font-size: 11px; color: #aaa; margin-top: 4px; }
    .verde .card-num { color: #25D366; }
    .amarillo .card-num { color: #FFC107; }
    .rojo .card-num { color: #f44336; }
    .azul .card-num { color: #2196F3; }
    .morado .card-num { color: #9C27B0; }
    .seccion { background: #16213e; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .seccion h3 { font-size: 13px; color: #25D366; margin-bottom: 14px; }
    .grafico { display: flex; align-items: flex-end; gap: 8px; height: 100px; margin-bottom: 8px; }
    .barra-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; }
    .barra { width: 100%; background: #25D366; border-radius: 4px 4px 0 0; min-height: 2px; }
    .barra.registros { background: #2196F3; }
    .barra-label { font-size: 9px; color: #aaa; margin-top: 4px; }
    .barra-valor { font-size: 9px; color: #fff; margin-bottom: 2px; }
    .nota { font-size: 11px; color: #888; margin-top: 8px; line-height: 1.5; }
    .back { display: block; text-align: center; margin-top: 16px; color: #25D366; text-decoration: none; font-size: 13px; }
  </style>
</head>
<body>
  <h1>📈 Dashboard Predictivo</h1>
  <p class="sub">DespensaClub Familiar — Proyecciones</p>

  <div class="grid">
    <div class="card verde">
      <div class="card-num">$${ingresoProyectadoTotal}</div>
      <div class="card-label">💰 Ingreso proyectado próx. 30 días</div>
    </div>
    <div class="card azul">
      <div class="card-num">${renovacionesProximas.length}</div>
      <div class="card-label">🔄 Renovaciones esperadas</div>
    </div>
    <div class="card ${tasaAbandono > 20 ? 'rojo' : 'amarillo'}">
      <div class="card-num">${tasaAbandono}%</div>
      <div class="card-label">📉 Tasa de abandono</div>
    </div>
    <div class="card morado">
      <div class="card-num">+${crecimientoPromedioMensual}</div>
      <div class="card-label">👥 Crecimiento prom./mes</div>
    </div>
    <div class="card verde">
      <div class="card-num">$${Math.round(promedioIngresoMensual)}</div>
      <div class="card-label">💵 Ingreso promedio mensual</div>
    </div>
    <div class="card amarillo">
      <div class="card-num">$${comisionesPendientes}</div>
      <div class="card-label">🎁 Comisiones por pagar</div>
    </div>
  </div>

  <div class="seccion">
    <h3>💰 Ingresos confirmados — últimos 6 meses</h3>
    <div class="grafico">
      ${Object.entries(ingresosPorMes).map(([mes, val]) => `
        <div class="barra-wrap">
          <div class="barra-valor">$${val}</div>
          <div class="barra" style="height:${Math.max((val / maxBarraIngresos) * 80, 2)}px"></div>
          <div class="barra-label">${mes}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <div class="seccion">
    <h3>👥 Crecimiento de red — últimos 6 meses ${tendencia}</h3>
    <div class="grafico">
      ${Object.entries(registrosPorMes).map(([mes, val]) => `
        <div class="barra-wrap">
          <div class="barra-valor">${val}</div>
          <div class="barra registros" style="height:${Math.max((val / maxBarraRegistros) * 80, 2)}px"></div>
          <div class="barra-label">${mes}</div>
        </div>
      `).join('')}
    </div>
    <div class="nota">Nuevos registros por mes, incluyendo DESP-000110/111.</div>
  </div>

  <div class="seccion">
    <h3>ℹ️ Cómo se calculan estas proyecciones</h3>
    <div class="nota">
      • <strong>Ingreso proyectado:</strong> usuarios activos × $${CONFIG_PRECIOS.despensa} (despensa) + membresías por vencer × $${CONFIG_PRECIOS.membresia}.<br><br>
      • <strong>Tasa de abandono:</strong> % de usuarios congelados o inactivos sobre el total (excluyendo DESP-000110/111).<br><br>
      • <strong>Crecimiento:</strong> promedio de nuevos registros por mes en los últimos 6 meses.<br><br>
      Estas son estimaciones basadas en el comportamiento actual, no garantías.
    </div>
  </div>

  <a class="back" href="/admin/dashboard?key=abb46f223b7cec4e6e3781421d2d1cd5">← Volver al Dashboard</a>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/dashboard', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
    <a class="btn" href="/admin/dashboard?key=abb46f223b7cec4e6e3781421d2d1cd5">📊 Dashboard</a>
    <a class="btn" href="/admin/predictivo?key=abb46f223b7cec4e6e3781421d2d1cd5">📈 Predictivo</a>
    <a class="btn" href="/admin/usuarios?key=abb46f223b7cec4e6e3781421d2d1cd5">👥 Usuarios</a>
    <a class="btn" href="/admin/arbol?key=abb46f223b7cec4e6e3781421d2d1cd5">🌳 Árbol</a>
    <a class="btn" href="/admin/lista?key=abb46f223b7cec4e6e3781421d2d1cd5">📋 Lista</a>
    <a class="btn" href="/admin/respaldo?key=abb46f223b7cec4e6e3781421d2d1cd5">📦 Respaldo</a>
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
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
      9: { bg: '#9E9E9E', text: '#fff', nombre: 'GRIS' },
      10: { bg: '#F44336', text: '#fff', nombre: 'ROJO' },
      11: { bg: '#03A9F4', text: '#fff', nombre: 'CELESTE' },
      12: { bg: '#9C27B0', text: '#fff', nombre: 'MAGENTA' },
      13: { bg: '#8BC34A', text: '#000', nombre: 'LIMA' },
      14: { bg: '#FF7043', text: '#fff', nombre: 'CORAL' },
      15: { bg: '#3F51B5', text: '#fff', nombre: 'ÍNDIGO' },
      16: { bg: '#009688', text: '#fff', nombre: 'MENTA' },
      17: { bg: '#795548', text: '#fff', nombre: 'BRONCE' },
      18: { bg: '#CE93D8', text: '#000', nombre: 'LAVANDA' },
      19: { bg: '#00897B', text: '#fff', nombre: 'ESMERALDA' }
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
      8: '#1B5E20', 9: '#9E9E9E', 10: '#F44336', 11: '#03A9F4',
      12: '#9C27B0', 13: '#8BC34A', 14: '#FF7043', 15: '#3F51B5',
      16: '#009688', 17: '#795548', 18: '#CE93D8', 19: '#00897B'
    };
    const COLORES_NOMBRE = {
      0: 'VIOLETA', 1: 'DORADO', 2: 'AZUL', 3: 'NARANJA', 4: 'ROSA',
      5: 'VERDE', 6: 'AMARILLO', 7: 'TURQUESA', 8: 'VERDE BANDERA', 9: 'GRIS',
      10: 'ROJO', 11: 'CELESTE', 12: 'MAGENTA', 13: 'LIMA', 14: 'CORAL',
      15: 'ÍNDIGO', 16: 'MENTA', 17: 'BRONCE', 18: 'LAVANDA', 19: 'ESMERALDA'
    };
    const color = COLORES_HEX[u.nivel || 0] || '#7B2FBE';
    const vigenciaStr = u.vigencia ? new Date(u.vigencia).toLocaleDateString('es-MX') : 'N/A';

    // Buscar nombres de referidos
    const referidosInfo = u.referidos && u.referidos.length > 0
      ? await Usuario.find({ id: { $in: u.referidos } }, 'id nombre activo').lean()
      : [];

    // Construir mi rama descendente completa (solo mis propios descendientes, por privacidad)
    const todosLosUsuarios = await Usuario.find({}, 'id nombre nivel referidoPor referidos activo').lean();

    function buildNodoMini(usuario, todos) {
      const c = COLORES_HEX[usuario.nivel || 0] || COLORES_HEX[0];
      const hijos = todos.filter(x => x.referidoPor === usuario.id);
      const hijosHTML = hijos.map(h => buildNodoMini(h, todos)).join('');
      return `
        <div class="mini-nodo-wrap">
          <div class="mini-nodo" style="background:${c}">
            <div class="mini-nodo-id">${usuario.id}</div>
            <div class="mini-nodo-nombre">${usuario.nombre}</div>
            <div class="mini-nodo-estado">${usuario.activo ? '✅' : '❌'}</div>
          </div>
          ${hijosHTML ? `<div class="mini-hijos">${hijosHTML}</div>` : ''}
        </div>`;
    }

    const miArbolHTML = referidosInfo.length > 0
      ? referidosInfo.map(r => {
          const rCompleto = todosLosUsuarios.find(x => x.id === r.id);
          return buildNodoMini(rCompleto, todosLosUsuarios);
        }).join('')
      : '<div class="vacio">Aún no tienes referidos. ¡Comparte tu código e invita a tu primera persona!</div>';

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
    .seccion-arbol { background: #16213e; border-radius: 12px; padding: 14px; margin-bottom: 12px; overflow-x: auto; }
    .seccion-arbol h3 { font-size: 13px; color: #25D366; margin-bottom: 10px; }
    .arbol-mini { display: flex; gap: 10px; padding-bottom: 8px; min-width: max-content; }
    .mini-nodo-wrap { display: inline-flex; flex-direction: column; align-items: center; }
    .mini-nodo { border-radius: 10px; padding: 6px 10px; min-width: 90px; max-width: 110px; text-align: center; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.4); margin-bottom: 6px; }
    .mini-nodo-id { font-size: 9px; opacity: 0.85; }
    .mini-nodo-nombre { font-size: 11px; font-weight: bold; word-break: break-word; }
    .mini-nodo-estado { font-size: 10px; margin-top: 2px; }
    .mini-hijos { display: flex; gap: 8px; border-top: 2px solid #0f3460; padding-top: 6px; margin-top: 0; }
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

  <div class="seccion-arbol">
    <h3>🌳 Mi rama (mi red descendente)</h3>
    <div class="arbol-mini">
      ${miArbolHTML}
    </div>
  </div>

  <div class="seccion">
    <h3>💰 Mis comisiones</h3>
    ${u.comisiones && u.comisiones.length > 0 ? `
      <div class="item" style="font-weight:bold;color:#25D366">
        Total acumulado: $${u.comisiones.reduce((s,c) => s + c.monto, 0)} pesos
      </div>
      ${[...u.comisiones].reverse().map(c => `
        <div class="item">
          <div>💵 $${c.monto} — de ${c.deNombre}</div>
          <div style="color:#aaa">${new Date(c.fecha).toLocaleDateString('es-MX')} ${c.pagada ? '✅ Pagada' : '⏳ Pendiente'}</div>
        </div>
      `).join('')}
    ` : '<div class="vacio">Aún no tienes comisiones generadas</div>'}
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

// ============================================================
// ESCANEO DE CREDENCIAL EN SUCURSAL — confirma pago en efectivo pendiente
// ============================================================
app.get('/admin/escanear/:id', async function(req, res) {
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
    return res.status(403).send('Acceso denegado');
  }
  const idU = req.params.id.toUpperCase();

  function pantalla(titulo, color, mensaje) {
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:sans-serif;background:#1a1a2e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:${color};border-radius:18px;padding:30px 24px;max-width:360px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
  h1{font-size:22px;margin-bottom:14px}
  p{font-size:15px;line-height:1.5}
  .btn{display:inline-block;margin-top:20px;padding:10px 24px;background:rgba(255,255,255,0.25);border-radius:10px;color:#fff;text-decoration:none;font-weight:bold;font-size:14px}
</style></head>
<body><div class="card"><h1>${titulo}</h1><p>${mensaje}</p>
<a class="btn" href="/admin/usuario/${idU}?key=abb46f223b7cec4e6e3781421d2d1cd5">Ver expediente</a>
</div></body></html>`);
  }

  try {
    const userU = await Usuario.findOne({ id: idU }).lean();
    if (!userU) return pantalla('❌ No encontrado', '#B71C1C', 'No existe el usuario ' + idU);

    const pagoPendiente = (userU.pagos || []).slice().reverse().find(p => p.estado === 'pendiente');
    if (!pagoPendiente) {
      return pantalla('ℹ️ Sin pagos pendientes', '#555', userU.nombre + ' (' + idU + ') no tiene ningún pago pendiente de confirmar en este momento.');
    }

    const resultado = await confirmarPagoPendiente(idU);
    if (!resultado.ok) {
      return pantalla('❌ Error', '#B71C1C', resultado.motivo);
    }

    return pantalla('✅ Pago confirmado',
      '#2E7D32',
      resultado.userU.nombre + '<br>' + idU + '<br><br>' +
      resultado.pago.concepto + ' — $' + resultado.pago.monto + ' pesos' +
      (resultado.estabaCongelado ? '<br><br>❄️➡️✅ Cuenta reactivada' : '')
    );
  } catch (err) {
    return pantalla('❌ Error', '#B71C1C', err.message);
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
        <p><a href="/admin/dashboard?key=abb46f223b7cec4e6e3781421d2d1cd5">📊 Dashboard</a></p>
        <p><a href="/admin/lista?key=abb46f223b7cec4e6e3781421d2d1cd5">📋 Ver lista de usuarios</a></p>
        <p><a href="/admin/arbol?key=abb46f223b7cec4e6e3781421d2d1cd5">🌳 Ver árbol jerárquico</a></p>
        <p><a href="/admin/respaldo?key=abb46f223b7cec4e6e3781421d2d1cd5">📦 Enviar respaldo</a></p>
        <p><a href="/admin/resetbd?key=abb46f223b7cec4e6e3781421d2d1cd5">🗑️ Reset base de datos</a></p>
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
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
  if (req.query.key !== 'abb46f223b7cec4e6e3781421d2d1cd5') {
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
  iniciarArchivado();
});
