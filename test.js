const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
});

client.on('qr', qr => {
    console.log('📱 Escanea el QR');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔐 Autenticado');
});

client.on('ready', () => {
    console.log('✅ BOT LISTO');
});

client.on('message', async msg => {
    console.log('📨 Mensaje recibido:', msg.body);
    await msg.reply('Funciona ✅');
});

client.initialize();
