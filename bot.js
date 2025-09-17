// ==========================
//      IMPORTS Y CONFIG
// ==========================
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const { google } = require('googleapis');

// ==========================
//      CONFIGURACIÓN DE GOOGLE SHEETS
// ==========================
const SPREADSHEET_ID = '1CtmcSFb2ScYXMAkK0EiKhmLJ1mwZRpGLTXZ8uXY-LRY';
const credenciales = require('./credenciales.json');
const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ==========================
//      CONFIG BASE
// ==========================
const ADMIN_PHONE = '18494736782';
let isBotBusy = false;
let client = null; // Para acceso global al cliente una vez iniciado

// ========= CACHÉ DE CLIENTES =========
let cachedClients = []; // Guardará los clientes en memoria
const CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutos

// ==========================
//      UTILIDADES GENERALES
// ==========================
const toDigits = (str) => String(str || '').replace(/\D/g, '');
const toChatId = (telefono) => {
    const digits = toDigits(telefono);
    const withCC = digits.startsWith('1') ? digits : `1${digits}`;
    return `${withCC}@c.us`;
};

function findClientById(clienteId) {
    if (!clienteId) return null;
    return cachedClients.find(c => c.id && c.id.toLowerCase() === clienteId.toLowerCase());
}

function findClientIndexById(clienteId) {
    if (!clienteId) return -1;
    return cachedClients.findIndex(c => c.id && c.id.toLowerCase() === clienteId.toLowerCase());
}

// ==========================
//      MENSAJES Y PLANTILLAS
// ==========================
const mensajeRecordatorioCliente = (c) => `Hola ${c.nombre} 👋
Tu servicio de ${c.servicio} con ID **${c.id}** vence hoy.
Para mantener tu acceso, por favor realiza tu pago.
📧 Correo: **${c.correo || 'No registrado'}**
📅 Vencimiento: **${moment(c.fecha, 'DD/MM/YYYY').format('DD-MM-YYYY')}**
👤 Perfil: **${c.perfil || 'No registrado'}**

⏰ Próximos vencimientos
📅 Si no puedes renovar con anticipación, tienes plazo hasta las 6:00 p.m. del día de vencimiento para completar tu pago y mantener activo el servicio.

🔄 ¿Cómo renovar?
1️⃣ Contacta a tu proveedor.
2️⃣ Envíale tu comprobante de pago.
⭕ Si no deseas renovar, no necesitas hacer nada.
🙏 ¡Gracias por tu confianza! Que tengas un excelente día.
`;
const mensajeAvisoAdmin = (c, aviso) => {
    const messages = [
        `🚨 ¡ALERTA! El cliente **${c.nombre}** no ha renovado a tiempo. Envío del primer recordatorio. Correo: **${c.correo}**`,
        `⚠️ SEGUNDO AVISO. El cliente **${c.nombre}** aún no ha pagado. Correo: **${c.correo}** Por favor, contacta con él..`,
        `❌ AVISO FINAL. El servicio de **${c.nombre}** está a punto de ser suspendido. Correo: **${c.correo}** Es urgente que contactes con él.`,
        `⛔️ SERVICIO SUSPENDIDO. El servicio de **${c.nombre}** ha sido cortado por falta de pago. Correo: **${c.correo}**`
    ];
    return messages[aviso];
};
const mensajeEntregaManual = (c) => `¡Hola ${c.nombre}! Aquí están los detalles de tu cuenta:
💻 Servicio: **${c.servicio}**
📧 Correo: **${c.correo}**
🔒 Contraseña: **${c.contraseña}**
👤 Perfil: **${c.perfil}**
📌 PIN: **${c.pin || 'No disponible'}**

Tu servicio vence el **${moment(c.fecha, 'DD/MM/YYYY').format('DD-MM-YYYY')}**.
`;
const menuAdmin = `
---
*Menú de Administrador*
1.  Entregar cuenta (Manual)
2.  Buscar cliente
3.  Enviar promoción
4.  Ganancias (hoy, mes, total)
5.  Ayuda
---
*Comandos adicionales:*
- *renovar [ID]*
- *actualizar* o *sync*
`;
const mensajeAyuda = `
---
*Comandos de Administrador*
-   *1 [ID del cliente]*: Para entregar una cuenta manualmente.
-   *2 [nombre/teléfono]*: Para buscar un cliente.
-   *3 [mensaje]*: Para enviar una promoción.
-   *ganancias [hoy/mes]*: Para ver el reporte de ingresos.
-   *renovar [ID del cliente]*: Para renovar por 30 días.
-   *actualizar*: Para forzar la sincronización con Google Sheets.
---
`;
const mensajeDatosCliente = (c) => `
---
*Detalles del Cliente*
**ID**: ${c.id}
**Nombre**: ${c.nombre}
**Teléfono**: ${c.telefono}
**Servicio**: ${c.servicio}
**Correo**: ${c.correo}
**Perfil**: ${c.perfil}
**Vencimiento**: ${moment(c.fecha, 'DD/MM/YYYY').format('DD-MM-YYYY')}
---
`;
// ==========================
//      CARGAR DATOS Y CACHÉ
// ==========================
async function cargarClientesDesdeSheet() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Clientes!A2:P',
        });
        const rows = response.data.values || [];
        return rows.map(row => ({
            id: row[0], nombre: row[1], telefono: row[2], servicio: row[3],
            correo: row[4], contraseña: row[5], perfil: row[6], pin: row[7],
            fecha: row[9], hora: row[10],
            // --- DATOS DE GANANCIAS EN PESOS (DOP) ---
            precioCompraDOP: parseFloat(row[14]) || 0, // Columna O: Precio de Compra
            precioVentaDOP: parseFloat(row[15]) || 0,  // Columna P: Precio de Venta
        }));
    } catch (error) {
        console.error('Error crítico al cargar clientes de Google Sheets:', error);
        return null;
    }
}

async function refreshClientsCache() {
    console.log('🔄 Actualizando caché de clientes desde Google Sheets...');
    isBotBusy = true;
    const clientes = await cargarClientesDesdeSheet();
    if (clientes) {
        cachedClients = clientes;
        console.log(`✅ Caché actualizado con ${cachedClients.length} clientes.`);
    } else {
        console.error('❌ No se pudo actualizar el caché de clientes.');
        if (client) {
            try {
                await client.sendMessage(toChatId(ADMIN_PHONE), '🚨 ¡ERROR CRÍTICO! No pude cargar los clientes desde Google Sheets. Revisa la consola del servidor.');
            } catch (e) {
                console.error('Error al notificar al admin sobre el fallo de carga.', e);
            }
        }
    }
    isBotBusy = false;
}

// ==========================
//      FUNCIONES PRINCIPALES
// ==========================
async function revisarYEnviarRecordatorios() {
    isBotBusy = true;
    console.log('🔄 Verificando clientes para recordatorios...');
    const clientes = cachedClients;
    const hoy = moment().tz('America/Santo_Domingo').startOf('day');
    for (const cliente of clientes) {
        if (cliente.fecha && cliente.telefono) {
            const fechaVencimiento = moment.tz(cliente.fecha, 'DD/MM/YYYY', 'America/Santo_Domingo').startOf('day');
            const diasHastaVencimiento = fechaVencimiento.diff(hoy, 'days');

            if (diasHastaVencimiento === 0) {
                try {
                    await client.sendMessage(toChatId(cliente.telefono), mensajeRecordatorioCliente(cliente));
                    await client.sendMessage(toChatId(ADMIN_PHONE), mensajeAvisoAdmin(cliente, 2));
                } catch (e) { console.error(`❌ Error enviando notificación a ${cliente.nombre}:`, e); }
            } else if (diasHastaVencimiento === 3) {
                try {
                    const mensaje3Dias = `Hola ${cliente.nombre}, tu servicio de ${cliente.servicio} vence en 3 días. Por favor, renueva a tiempo...`;
                    await client.sendMessage(toChatId(cliente.telefono), mensaje3Dias);
                    await client.sendMessage(toChatId(ADMIN_PHONE), `🚨 Aviso: El servicio de ${cliente.nombre} vence en 3 días.`);
                } catch (e) { console.error(`❌ Error enviando notificación a ${cliente.nombre}:`, e); }
            }
        }
    }
    isBotBusy = false;
    console.log('✅ Verificación de recordatorios completada.');
}

// ==========================
//      FUNCIÓN DE GANANCIAS (ACTUALIZADA)
// ==========================
async function calcularGanancias(jid, periodo) {
    const hoy = moment().tz('America/Santo_Domingo');
    let clientesFiltrados = [];
    let tituloReporte = '';

    if (periodo === 'hoy') {
        tituloReporte = 'de Hoy';
        clientesFiltrados = cachedClients.filter(c => {
            if (!c.fecha) return false;
            const fechaCliente = moment(c.fecha, 'DD/MM/YYYY');
            return fechaCliente.isSame(hoy, 'day');
        });
    } else if (periodo === 'mes') {
        tituloReporte = 'de Este Mes';
        clientesFiltrados = cachedClients.filter(c => {
            if (!c.fecha) return false;
            const fechaCliente = moment(c.fecha, 'DD/MM/YYYY');
            return fechaCliente.isSame(hoy, 'month');
        });
    } else {
        tituloReporte = 'Totales';
        clientesFiltrados = cachedClients;
    }

    if (clientesFiltrados.length === 0) {
        await client.sendMessage(jid, `No se encontraron transacciones para el reporte *${tituloReporte}*`);
        return;
    }

    const totales = clientesFiltrados.reduce((acc, cliente) => {
        acc.ventaDOP += cliente.precioVentaDOP;
        acc.compraDOP += cliente.precioCompraDOP;
        return acc;
    }, { ventaDOP: 0, compraDOP: 0 });

    const gananciaNeta = totales.ventaDOP - totales.compraDOP;

    const mensaje = `
---
*📊 Reporte de Ganancias (DOP) ${tituloReporte}*
---
*Ventas Totales:* $${totales.ventaDOP.toFixed(2)} DOP
*Costos Totales:* $${totales.compraDOP.toFixed(2)} DOP
*Ganancia Neta:* *$${gananciaNeta.toFixed(2)} DOP*
*Total de transacciones: ${clientesFiltrados.length}*
`;
    await client.sendMessage(jid, mensaje);
}

// ==========================
//      FUNCIONES DE COMANDOS
// ==========================
async function entregarCuentaManual(jid, clienteId) {
    console.log(`🔄 Buscando cliente con ID: ${clienteId} para entrega manual...`);
    const clienteEncontrado = findClientById(clienteId);
    if (clienteEncontrado) {
        try {
            await client.sendMessage(toChatId(clienteEncontrado.telefono), mensajeEntregaManual(clienteEncontrado));
            await client.sendMessage(jid, `✅ Cuenta de **${clienteEncontrado.nombre}** (${clienteEncontrado.id}) entregada con éxito.`);
        } catch (e) {
            await client.sendMessage(jid, `❌ Error al enviar la cuenta a **${clienteEncontrado.nombre}**.`);
        }
    } else {
        await client.sendMessage(jid, `❌ No se encontró ningún cliente con el ID **${clienteId}**.`);
    }
}

async function buscarCliente(jid, query) {
    console.log(`🔎 Buscando cliente por: ${query}...`);
    const queryLower = query.toLowerCase();
    const queryDigits = toDigits(query);
    const clientesEncontrados = cachedClients.filter(c =>
        (c.nombre && c.nombre.toLowerCase().includes(queryLower)) ||
        (c.telefono && toDigits(c.telefono).includes(queryDigits))
    );
    if (clientesEncontrados.length > 0) {
        let mensajeCompleto = '✅ Clientes encontrados:\n\n';
        clientesEncontrados.forEach(c => {
            mensajeCompleto += mensajeDatosCliente(c);
        });
        await client.sendMessage(jid, mensajeCompleto);
    } else {
        await client.sendMessage(jid, `❌ No se encontró ningún cliente que coincida con la búsqueda: **${query}**.`);
    }
}

async function enviarPromoATodos(jid, mensajePromo) {
    isBotBusy = true;
    await client.sendMessage(jid, `🚀 Iniciando el envío de la promoción...`);
    const numerosUnicos = new Set();
    const clientesSinDuplicados = cachedClients.filter(cliente => {
        if (cliente.telefono && !numerosUnicos.has(cliente.telefono)) {
            numerosUnicos.add(cliente.telefono);
            return true;
        }
        return false;
    });
    let enviados = 0, fallidos = 0;
    for (const cliente of clientesSinDuplicados) {
        try {
            await client.sendMessage(toChatId(cliente.telefono), `📢 *¡AVISO⚠️!* 🎉\n\n${mensajePromo}`);
            enviados++;
            await new Promise(resolve => setTimeout(resolve, 1500));
        } catch (e) {
            console.error(`❌ Error al enviar promoción a ${cliente.nombre} (${cliente.telefono}):`, e);
            fallidos++;
        }
    }
    await client.sendMessage(jid, `✅ Promoción enviada a ${enviados} cliente(s).\n❌ Falló el envío a ${fallidos} cliente(s).`);
    isBotBusy = false;
}

async function renovarClienteEnSheet(clienteId, dias) {
    try {
        const clienteEncontrado = findClientById(clienteId);
        if (!clienteEncontrado) return false;

        const fechaBase = clienteEncontrado.fecha ? moment(clienteEncontrado.fecha, 'DD/MM/YYYY') : moment();
        const nuevaFecha = fechaBase.add(dias, 'days').format('YYYY/MM/DD');

        const clienteIndex = cachedClients.findIndex(c => c.id && c.id.toLowerCase() === clienteId.toLowerCase());
        const fila = clienteIndex + 2;
        const rango = `Clientes!J${fila}`;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: rango,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[nuevaFecha]] },
        });

        await refreshClientsCache();

        const mensajeRenovacion = `✅ ¡Hola ${clienteEncontrado.nombre}! Tu servicio de ${clienteEncontrado.servicio} ha sido renovado por **${dias}** días. Tu nueva fecha de vencimiento es el **${moment(nuevaFecha, 'YYYY/MM/DD').format('DD-MM-YYYY')}**. ¡Gracias por tu pago!`;
        await client.sendMessage(toChatId(clienteEncontrado.telefono), mensajeRenovacion);

        return nuevaFecha;
    } catch (error) {
        console.error(`❌ Error al renovar el cliente ${clienteId}:`, error.message);
        return false;
    }
}

// ==========================
//      FUNCIÓN PRINCIPAL
// ==========================
async function start() {
    console.log('🤖 Iniciando bot con whatsapp-web.js...');

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox'],
            headless: true
        },
    });

    client.on('qr', qr => {
        console.log('QR RECIBIDO');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ ¡Cliente listo y conectado!');
        refreshClientsCache();
        schedule.scheduleJob('0 * * * *', refreshClientsCache);
        schedule.scheduleJob({ hour: 11, minute: 40, tz: 'America/Santo_Domingo' }, revisarYEnviarRecordatorios);
        schedule.scheduleJob('0 * * * *', () => {
            client.sendMessage(toChatId(ADMIN_PHONE), '🕒 El bot sigue activo y en funcionamiento.');
        });
    });

    client.on('auth_failure', msg => {
        console.error('❌ Fallo en la autenticación, revisa tu QR o sesión:', msg);
    });

    client.on('disconnected', (reason) => {
        console.error('❌ Cliente desconectado. Razón:', reason);
    });

    const lastMessageTimestamps = new Map();

    client.on('message', async (msg) => {
        const { from: jid, body: text } = msg;

        if (isBotBusy) {
            await client.sendMessage(jid, 'Estoy procesando una tarea en este momento. Por favor, espera unos segundos e inténtalo de nuevo.');
            return;
        }

        if (jid === toChatId(ADMIN_PHONE)) {
            // Lógica de comandos de administrador
            const comando = text.toLowerCase();
            const partes = text.trim().split(' ');
            const comandoPrincipal = partes[0].toLowerCase();
            const args = partes.slice(1);

            switch (comandoPrincipal) {
                case 'menu':
                    await client.sendMessage(jid, menuAdmin);
                    break;
                case '1':
                    if (args.length > 0) {
                        await entregarCuentaManual(jid, args[0]);
                    } else {
                        await client.sendMessage(jid, '❌ Comando incorrecto. Usa: *1 [ID del cliente]*');
                    }
                    break;
                case '2':
                    if (args.length > 0) {
                        const query = args.join(' ');
                        await buscarCliente(jid, query);
                    } else {
                        await client.sendMessage(jid, '❌ Comando incorrecto. Usa: *2 [nombre/teléfono]*');
                    }
                    break;
                case '3':
                    if (args.length > 0) {
                        const mensaje = args.join(' ');
                        await enviarPromoATodos(jid, mensaje);
                    } else {
                        await client.sendMessage(jid, '❌ Comando incorrecto. Usa: *3 [mensaje]*');
                    }
                    break;
                case 'ganancias':
                    if (args.length > 0) {
                        await calcularGanancias(jid, args[0]);
                    } else {
                        await client.sendMessage(jid, '❌ Comando incorrecto. Usa: *ganancias [hoy/mes]*');
                    }
                    break;
                case 'renovar':
                    const partesRenovar = args.join(' ').split(' ');
                    const clienteId = partesRenovar[0];
                    const dias = parseInt(partesRenovar[1]) || 30;
                    if (!clienteId) {
                        await client.sendMessage(jid, '❌ Falta el ID del cliente. Ejemplo: *renovar C1 60* para añadir 60 días.');
                        return;
                    }
                    await client.sendMessage(jid, `🔄 Renovando cliente **${clienteId}** por **${dias}** días...`);
                    const nuevaFechaRenovacion = await renovarClienteEnSheet(clienteId, dias);
                    if (nuevaFechaRenovacion) {
                        await client.sendMessage(jid, `✅ Cliente **${clienteId}** renovado con éxito. Nueva fecha: ${moment(nuevaFechaRenovacion, 'YYYY/MM/DD').format('DD-MM-YYYY')}.`);
                    } else {
                        await client.sendMessage(jid, `❌ No se pudo encontrar o renovar al cliente **${clienteId}**.`);
                    }
                    break;
                case 'actualizar':
                case 'sync':
                    await refreshClientsCache();
                    await client.sendMessage(jid, '✅ Caché sincronizado manualmente.');
                    break;
                case 'ayuda':
                    await client.sendMessage(jid, mensajeAyuda);
                    break;
                default:
                    await client.sendMessage(jid, '🤔 Comando no reconocido. Por favor, usa *menu* para ver las opciones.');
            }

        } else {
            // Lógica para usuarios normales
            const textoComando = text.toLowerCase();
            const now = moment();
            const lastMessageTime = lastMessageTimestamps.get(jid);
            if (!lastMessageTime || now.diff(lastMessageTime, 'hours') >= 24) {
                if (textoComando === 'datos') {
                    const telefonoUsuario = toDigits(jid);
                    const cuentasEncontradas = cachedClients.filter(c => c.telefono && toDigits(c.telefono).includes(telefonoUsuario));
                    if (cuentasEncontradas.length > 0) {
                        if (cuentasEncontradas.length > 1) {
                            await client.sendMessage(jid, `¡Hola! Encontramos *${cuentasEncontradas.length} cuentas* asociadas a tu número. Te las enviaré una por una:`);
                        }
                        for (const cuenta of cuentasEncontradas) {
                            await client.sendMessage(jid, mensajeEntregaManual(cuenta));
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    } else {
                        await client.sendMessage(jid, '❌ Lo siento, no pude encontrar ninguna cuenta asociada a tu número. Por favor, contacta a tu proveedor para más ayuda.');
                    }
                } else if (textoComando === 'ayuda' || textoComando === 'menu') {
                    await client.sendMessage(jid, 'Hola! Soy un bot de recordatorios de pago. Si necesitas recuperar los datos de tu cuenta, envía la palabra *datos*. Para más información, contacta a tu proveedor.');
                } else {
                    // La forma correcta de enviar un mensaje con whatsapp-web.js
await client.sendMessage(jid, '😊 ¡Hola! Un gusto saludarte. ¿En qué podemos ayudarte hoy? Sé paciente, en unos minutos te atenderemos. Si tienes algún problema, por favor, cuéntanos a detalle. ¡Gracias!');
                }
                lastMessageTimestamps.set(jid, now);
            }
        }
    });

    client.initialize();
}

start();